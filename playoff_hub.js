// =============================================================================
// playoff_hub.js — dedicated UI for managing all playoff brackets
// =============================================================================
// Fullscreen overlay covering both regular leagues and specialty leagues.
// Reads/writes through PlayoffMode helpers so state stays compatible with
// the per-league embedded UI.
//
// Public API: window.PlayoffHub
//   .open()   open the overlay
//   .close()  close it
// =============================================================================
(function () {
    'use strict';

    var VERSION = '2.0.0';
    var _overlayEl = null;
    var _selectedKey = null;          // "regular:1st Grade" | "specialty:<id>"
    var _activeKind = 'regular';      // current tab
    var _setupExpanded = false;       // toggles seeds/style visibility once rounds exist

    function escHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // -------------------------------------------------------------------------
    // Data accessors
    // -------------------------------------------------------------------------

    function _regularLeagues() {
        var lbn = (window.loadGlobalSettings && window.loadGlobalSettings()?.leaguesByName) || window.leaguesByName || {};
        return Object.keys(lbn).sort().map(function (n) { return { kind: 'regular', key: 'regular:' + n, league: lbn[n] }; }).filter(function (x) { return x.league; });
    }
    function _specialtyLeagues() {
        var sl = (window.loadGlobalSettings && window.loadGlobalSettings()?.specialtyLeagues) || window.specialtyLeagues || {};
        return Object.keys(sl).map(function (id) { return { kind: 'specialty', key: 'specialty:' + id, league: sl[id], id: id }; }).filter(function (x) { return x.league; })
            .sort(function (a, b) { return (a.league.name || '').localeCompare(b.league.name || ''); });
    }
    function _leaguesByKind(kind) {
        return kind === 'specialty' ? _specialtyLeagues() : _regularLeagues();
    }
    function _findByKey(key) {
        if (!key) return null;
        if (key.startsWith('regular:')) return _regularLeagues().find(function (x) { return x.key === key; }) || null;
        if (key.startsWith('specialty:')) return _specialtyLeagues().find(function (x) { return x.key === key; }) || null;
        return null;
    }
    function _saveFor(entry) {
        if (!entry) return;
        if (entry.kind === 'regular') {
            // Best path: leagues.js's internal saveLeaguesData (not exported).
            // Fallback: write the leaguesByName map via saveGlobalSettings.
            var lbn = window.leaguesByName || {};
            if (typeof window.saveGlobalSettings === 'function') {
                try { window.saveGlobalSettings('leaguesByName', lbn); } catch (_) {}
            }
        } else {
            // Specialty leagues live under window.specialtyLeagues.
            var sl = window.specialtyLeagues || {};
            if (typeof window.saveGlobalSettings === 'function') {
                try { window.saveGlobalSettings('specialtyLeagues', sl); } catch (_) {}
            }
        }
    }
    function _statusOf(league) {
        var p = window.PlayoffMode?.getOrInit?.(league);
        if (!p || !p.enabled) return { label: 'Off', cls: 'off' };
        if (!p.rounds || p.rounds.length === 0) return { label: 'Setup', cls: 'setup' };
        var lastRound = p.rounds[p.rounds.length - 1];
        if (lastRound.matchups && lastRound.matchups.length === 1 && lastRound.matchups[0].winner) {
            return { label: 'Champion', cls: 'champ' };
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
        body.appendChild(_renderSidebar());

        var entry = _findByKey(_selectedKey);
        var leagues = _leaguesByKind(_activeKind);

        // Auto-pick first league when nothing selected (or selection moved tabs)
        if (!entry && leagues.length > 0) {
            _selectedKey = leagues[0].key;
            entry = leagues[0];
        }

        if (!entry) {
            var empty = document.createElement('div');
            empty.className = 'ph-content ph-empty';
            var msg = (_activeKind === 'specialty')
                ? 'No specialty leagues yet. Create one in the Specialty Leagues tab to run a playoff bracket.'
                : 'No leagues yet. Create one in League Setup to run a playoff bracket.';
            empty.innerHTML = '<div class="ph-empty-title">Nothing here yet</div>'
                + '<div class="ph-empty-sub">' + escHtml(msg) + '</div>';
            body.appendChild(empty);
            return;
        }

        body.appendChild(_renderLeagueView(entry));
    }

    function _renderSidebar() {
        var aside = document.createElement('aside');
        aside.className = 'ph-sidebar';

        // Tabs: Regular | Specialty
        var tabs = document.createElement('div');
        tabs.className = 'ph-tabs';
        [
            { kind: 'regular',   label: 'Regular' },
            { kind: 'specialty', label: 'Specialty' }
        ].forEach(function (t) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'ph-tab' + (_activeKind === t.kind ? ' active' : '');
            b.textContent = t.label;
            var count = _leaguesByKind(t.kind).length;
            if (count > 0) {
                var badge = document.createElement('span');
                badge.className = 'ph-tab-count';
                badge.textContent = count;
                b.appendChild(badge);
            }
            b.onclick = function () {
                if (_activeKind === t.kind) return;
                _activeKind = t.kind;
                // Reset selection to first in the new tab so the right side stays in sync
                var first = _leaguesByKind(t.kind)[0];
                _selectedKey = first ? first.key : null;
                _setupExpanded = false;
                _render();
            };
            tabs.appendChild(b);
        });
        aside.appendChild(tabs);

        var list = document.createElement('div');
        list.className = 'ph-league-list';

        var leagues = _leaguesByKind(_activeKind);
        if (leagues.length === 0) {
            var none = document.createElement('div');
            none.className = 'ph-list-empty';
            none.textContent = (_activeKind === 'specialty')
                ? 'No specialty leagues created.'
                : 'No leagues created.';
            list.appendChild(none);
        } else {
            leagues.forEach(function (entry) {
                var st = _statusOf(entry.league);
                var row = document.createElement('button');
                row.type = 'button';
                row.className = 'ph-league-row' + (entry.key === _selectedKey ? ' selected' : '');
                row.onclick = function () {
                    _selectedKey = entry.key;
                    _setupExpanded = false;
                    _render();
                };

                var nameEl = document.createElement('div');
                nameEl.className = 'ph-league-name';
                nameEl.textContent = entry.league.name || '(unnamed)';

                var statusBadge = document.createElement('span');
                statusBadge.className = 'ph-status ph-status-' + st.cls;
                statusBadge.textContent = st.label;

                row.appendChild(nameEl);
                row.appendChild(statusBadge);
                list.appendChild(row);
            });
        }

        aside.appendChild(list);
        return aside;
    }

    function _renderLeagueView(entry) {
        var league = entry.league;
        var content = document.createElement('main');
        content.className = 'ph-content';

        var p = window.PlayoffMode.getOrInit(league);
        var hasRounds = p.enabled && p.rounds && p.rounds.length > 0;
        var lastRound = hasRounds ? p.rounds[p.rounds.length - 1] : null;
        var isChampion = lastRound && lastRound.matchups && lastRound.matchups.length === 1 && lastRound.matchups[0].winner;
        var roundComplete = lastRound && window.PlayoffMode.isRoundComplete(lastRound);

        // ── HEADER: name + ON/OFF toggle
        var hdr = document.createElement('div');
        hdr.className = 'ph-content-head';

        var title = document.createElement('div');
        title.className = 'ph-content-title';
        title.textContent = league.name || '(unnamed)';
        hdr.appendChild(title);

        var enableLab = document.createElement('label');
        enableLab.className = 'ph-toggle' + (p.enabled ? ' on' : '');
        var enableCb = document.createElement('input');
        enableCb.type = 'checkbox';
        enableCb.checked = !!p.enabled;
        enableCb.onchange = function () {
            p.enabled = enableCb.checked;
            _saveFor(entry);
            _render();
        };
        enableLab.appendChild(enableCb);
        var enableTxt = document.createElement('span');
        enableTxt.textContent = p.enabled ? 'Playoff: On' : 'Playoff: Off';
        enableLab.appendChild(enableTxt);
        hdr.appendChild(enableLab);

        content.appendChild(hdr);

        if (!p.enabled) {
            var off = document.createElement('div');
            off.className = 'ph-explainer';
            off.textContent = 'Turn on Playoff to override regular round-robin scheduling with a single-elimination bracket. Each matchup gets its own sport + field, and the scheduler advances winners round by round.';
            content.appendChild(off);
            return content;
        }

        // ── SETUP SECTION ────────────────────────────────────────────────
        // Show seeds + style as the main view when no rounds exist.
        // Once rounds exist, collapse them into a small disclosure so the
        // bracket is the visual anchor.
        if (!hasRounds || _setupExpanded) {
            content.appendChild(_renderSetup(entry, p));

            // Generate Round 1 / Regenerate (only relevant when seeds present)
            var actions = document.createElement('div');
            actions.className = 'ph-actions-row';
            var genBtn = document.createElement('button');
            genBtn.type = 'button';
            genBtn.className = 'ph-btn primary';
            genBtn.textContent = hasRounds ? 'Regenerate from seeds' : 'Generate Round 1 →';
            genBtn.disabled = (p.seedOrder || []).length < 2;
            genBtn.onclick = function () {
                if (hasRounds && !confirm('This discards existing rounds and winners. Continue?')) return;
                var r1 = window.PlayoffMode.generateRound1(p.seedOrder, p.style);
                p.rounds = [{ number: 1, matchups: r1 }];
                p.currentRound = 1;
                _setupExpanded = false;
                _saveFor(entry);
                _render();
            };
            actions.appendChild(genBtn);

            if (hasRounds && _setupExpanded) {
                var doneBtn = document.createElement('button');
                doneBtn.type = 'button';
                doneBtn.className = 'ph-btn ghost';
                doneBtn.textContent = 'Done editing';
                doneBtn.onclick = function () { _setupExpanded = false; _render(); };
                actions.appendChild(doneBtn);
            }
            content.appendChild(actions);
        } else {
            // Compact summary bar with "Edit setup" disclosure
            var bar = document.createElement('div');
            bar.className = 'ph-setup-bar';

            var styleLabel = (p.style === 'reseed') ? 'Re-seed (top vs bottom)' : 'Fixed bracket (NBA-style)';
            var seedsLabel = (p.seedOrder || []).length + ' seed' + ((p.seedOrder || []).length === 1 ? '' : 's');
            var info = document.createElement('div');
            info.className = 'ph-setup-bar-info';
            info.innerHTML = '<span class="ph-pill-label">' + escHtml(styleLabel) + '</span>'
                + '<span class="ph-pill-label">' + escHtml(seedsLabel) + '</span>';
            bar.appendChild(info);

            var editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.className = 'ph-btn ghost small';
            editBtn.textContent = 'Edit setup';
            editBtn.onclick = function () { _setupExpanded = true; _render(); };
            bar.appendChild(editBtn);

            var clearBtn = document.createElement('button');
            clearBtn.type = 'button';
            clearBtn.className = 'ph-btn ghost small danger';
            clearBtn.textContent = 'Clear bracket';
            clearBtn.onclick = function () {
                if (!confirm('Clear the entire bracket for ' + (league.name || 'this league') + '?')) return;
                p.rounds = []; p.currentRound = 1;
                _saveFor(entry); _render();
            };
            bar.appendChild(clearBtn);

            content.appendChild(bar);
        }

        // ── BRACKET ──────────────────────────────────────────────────────
        if (hasRounds) {
            content.appendChild(_renderBracket(entry, p));

            // Advance / Champion
            var nonByeWinners = (lastRound.matchups || []).filter(function (m) { return m && m.winner && m.winner !== 'BYE'; }).length;
            if (roundComplete && nonByeWinners >= 2) {
                var advRow = document.createElement('div');
                advRow.className = 'ph-actions-row';
                var advBtn = document.createElement('button');
                advBtn.type = 'button';
                advBtn.className = 'ph-btn primary big';
                advBtn.textContent = 'Generate Round ' + (lastRound.number + 1) + ' →';
                advBtn.onclick = function () {
                    var nextMatchups = (p.style === 'reseed')
                        ? window.PlayoffMode.advanceReseed(lastRound, p.seedOrder)
                        : window.PlayoffMode.advanceFixed(lastRound);
                    p.rounds.push({ number: lastRound.number + 1, matchups: nextMatchups });
                    p.currentRound = lastRound.number + 1;
                    _saveFor(entry); _render();
                };
                advRow.appendChild(advBtn);
                content.appendChild(advRow);
            } else if (isChampion) {
                var champ = document.createElement('div');
                champ.className = 'ph-champion';
                champ.innerHTML = '<div class="ph-champion-label">Champion</div>'
                    + '<div class="ph-champion-name">' + escHtml(lastRound.matchups[0].winner) + '</div>';
                content.appendChild(champ);
            } else if (lastRound.matchups && lastRound.matchups.length > 0) {
                // In-progress hint
                var todo = (lastRound.matchups || []).filter(function (m) { return m && !m.winner && !m.isBye; }).length;
                if (todo > 0) {
                    var hint = document.createElement('div');
                    hint.className = 'ph-explainer subtle';
                    hint.textContent = todo + ' matchup' + (todo === 1 ? '' : 's') + ' still need a winner. Click a team to mark it.';
                    content.appendChild(hint);
                }
            }
        }

        // ── RESERVATIONS ─────────────────────────────────────────────────
        content.appendChild(_renderReservedCard(entry, league, p));

        return content;
    }

    function _renderSetup(entry, p) {
        var card = document.createElement('div');
        card.className = 'ph-setup-card';

        // Step 1 — Style
        var s1 = document.createElement('div');
        s1.className = 'ph-step';
        s1.innerHTML = '<div class="ph-step-num">1</div>'
            + '<div class="ph-step-body"><div class="ph-step-title">Bracket style</div>'
            + '<div class="ph-step-sub">How are winners paired in each round?</div></div>';
        var styleRow = document.createElement('div');
        styleRow.className = 'ph-style-row';
        [
            { v: 'fixed',  t: 'Fixed bracket', d: 'NBA-style. 1v8 winner plays 4v5 winner.' },
            { v: 'reseed', t: 'Re-seed',       d: 'Top remaining seed always plays the bottom.' }
        ].forEach(function (opt) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ph-pill' + (p.style === opt.v ? ' active' : '');
            btn.innerHTML = '<strong>' + escHtml(opt.t) + '</strong><span>' + escHtml(opt.d) + '</span>';
            btn.onclick = function () { p.style = opt.v; _saveFor(entry); _render(); };
            styleRow.appendChild(btn);
        });
        s1.querySelector('.ph-step-body').appendChild(styleRow);
        card.appendChild(s1);

        // Step 2 — Seeds
        var s2 = document.createElement('div');
        s2.className = 'ph-step';
        s2.innerHTML = '<div class="ph-step-num">2</div>'
            + '<div class="ph-step-body"><div class="ph-step-title">Seeds</div>'
            + '<div class="ph-step-sub">1 = top seed. Drag to reorder. Non-power-of-2 brackets give byes to the top seeds.</div></div>';
        s2.querySelector('.ph-step-body').appendChild(_renderSeedList(entry, p));
        card.appendChild(s2);

        return card;
    }

    function _renderSeedList(entry, p) {
        var league = entry.league;
        var teams = (league.teams || []).slice();
        // Drop dead seeds
        p.seedOrder = (p.seedOrder || []).filter(function (t) { return teams.indexOf(t) >= 0; });

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
                teams.forEach(function (t) { if (sorted.indexOf(t) === -1) sorted.push(t); });
                p.seedOrder = sorted;
                _saveFor(entry);
            }
        }

        var wrap = document.createElement('div');
        wrap.className = 'ph-seed-wrap';

        var list = document.createElement('div');
        list.className = 'ph-seed-list';

        if (p.seedOrder.length === 0) {
            var empty = document.createElement('div');
            empty.className = 'ph-seed-empty';
            empty.textContent = 'No teams seeded yet — add them below.';
            list.appendChild(empty);
        } else {
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
                up.type = 'button'; up.textContent = '↑'; up.disabled = idx === 0;
                up.onclick = function () {
                    var t = p.seedOrder[idx - 1]; p.seedOrder[idx - 1] = p.seedOrder[idx]; p.seedOrder[idx] = t;
                    _saveFor(entry); _render();
                };
                var down = document.createElement('button');
                down.type = 'button'; down.textContent = '↓'; down.disabled = idx === p.seedOrder.length - 1;
                down.onclick = function () {
                    var t = p.seedOrder[idx + 1]; p.seedOrder[idx + 1] = p.seedOrder[idx]; p.seedOrder[idx] = t;
                    _saveFor(entry); _render();
                };
                var rm = document.createElement('button');
                rm.type = 'button'; rm.textContent = '×'; rm.title = 'Remove from seeds';
                rm.onclick = function () {
                    p.seedOrder = p.seedOrder.filter(function (x) { return x !== team; });
                    _saveFor(entry); _render();
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
                    _saveFor(entry); _render();
                };

                list.appendChild(row);
            });
        }
        wrap.appendChild(list);

        // Add unseeded
        var unseeded = teams.filter(function (t) { return p.seedOrder.indexOf(t) < 0; });
        if (unseeded.length > 0) {
            var addRow = document.createElement('div');
            addRow.className = 'ph-seed-add';
            var sel = document.createElement('select');
            sel.innerHTML = '<option value="">+ Add team to seeds</option>'
                + unseeded.map(function (t) { return '<option value="' + escHtml(t) + '">' + escHtml(t) + '</option>'; }).join('');
            sel.onchange = function () {
                if (!sel.value) return;
                p.seedOrder.push(sel.value);
                _saveFor(entry); _render();
            };
            addRow.appendChild(sel);

            if (unseeded.length > 1) {
                var allBtn = document.createElement('button');
                allBtn.type = 'button';
                allBtn.className = 'ph-btn ghost small';
                allBtn.textContent = 'Add all';
                allBtn.onclick = function () {
                    unseeded.forEach(function (t) { p.seedOrder.push(t); });
                    _saveFor(entry); _render();
                };
                addRow.appendChild(allBtn);
            }
            wrap.appendChild(addRow);
        }
        return wrap;
    }

    function _renderBracket(entry, p) {
        var wrap = document.createElement('div');
        wrap.className = 'ph-bracket-wrap';

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
                col.appendChild(_renderMatchup(entry, p, round, m, mi, isSettled));
            });

            bracket.appendChild(col);
        });

        wrap.appendChild(bracket);
        return wrap;
    }

    function _renderMatchup(entry, p, round, m, mi, isSettled) {
        var league = entry.league;
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
                          + (m.winner === name ? '<span class="ph-team-check">✓</span>' : '');
            btn.onclick = function () {
                m.winner = (m.winner === name) ? null : name;
                _saveFor(entry);
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
            byeNote.textContent = 'Bye — auto advances';
            box.appendChild(byeNote);
            return box;
        }

        // Sport selector
        var sportRow = document.createElement('div');
        sportRow.className = 'ph-pickrow';
        sportRow.innerHTML = '<span class="ph-pickrow-label">Sport</span>';
        var sportSel = document.createElement('select');
        sportSel.disabled = isSettled;
        sportSel.innerHTML = '<option value="">Pick…</option>'
            + (league.sports || []).map(function (s) {
                return '<option value="' + escHtml(s) + '"' + (m.sport === s ? ' selected' : '') + '>' + escHtml(s) + '</option>';
            }).join('');
        sportSel.onchange = function () {
            m.sport = sportSel.value;
            if (m.field && _fieldsForSport(m.sport).indexOf(m.field) < 0) m.field = '';
            _saveFor(entry); _render();
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
            fieldSel.innerHTML = '<option value="">Pick sport first</option>';
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
            _saveFor(entry);
        };
        fieldRow.appendChild(fieldSel);
        box.appendChild(fieldRow);

        return box;
    }

    function _renderReservedCard(entry, league, p) {
        var card = document.createElement('div');
        card.className = 'ph-reserved-card';

        var head = document.createElement('div');
        head.className = 'ph-reserved-head';
        head.innerHTML = '<div class="ph-reserved-title">Activities for non-playing kids</div>'
            + '<div class="ph-reserved-sub">Locked during the playoff slot for ' + escHtml((league.divisions || []).join(', ') || 'this league\'s grades') + ' so the auto-scheduler routes eliminated/not-playing bunks into them.</div>';
        card.appendChild(head);

        var chips = document.createElement('div');
        chips.className = 'ph-chips';
        var allActs = _allFacilityNames();
        if (allActs.length === 0) {
            var none = document.createElement('div');
            none.className = 'ph-reserved-sub';
            none.style.marginTop = '6px';
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
                    _saveFor(entry); _render();
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
        if (_overlayEl) return;
        _injectStyles();
        // Default to whichever tab has at least one league
        if (_leaguesByKind('regular').length === 0 && _leaguesByKind('specialty').length > 0) {
            _activeKind = 'specialty';
        }
        _setupExpanded = false;
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
        _overlayEl.addEventListener('click', function (e) { if (e.target === _overlayEl) close(); });
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
    // Styles
    // -------------------------------------------------------------------------

    function _injectStyles() {
        if (document.getElementById('playoff-hub-styles')) return;
        var st = document.createElement('style');
        st.id = 'playoff-hub-styles';
        st.textContent = [
            '.ph-overlay{position:fixed;inset:0;background:rgba(15,23,42,0.55);z-index:9000;display:flex;align-items:stretch;justify-content:center;padding:24px;backdrop-filter:blur(3px);}',
            '.ph-shell{flex:1;max-width:1280px;background:#fff;border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,0.35);display:flex;flex-direction:column;overflow:hidden;}',
            '.ph-header{display:flex;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid #E5E7EB;background:#F9FAFB;}',
            '.ph-title{font-size:1.1rem;font-weight:700;color:#0F172A;letter-spacing:-0.01em;}',
            '.ph-close{background:transparent;border:1px solid #E5E7EB;color:#475569;width:32px;height:32px;border-radius:8px;font-size:1.4rem;cursor:pointer;line-height:1;}',
            '.ph-close:hover{background:#F1F5F9;border-color:#CBD5E1;color:#0F172A;}',
            '.ph-body{flex:1;display:flex;overflow:hidden;}',

            // sidebar
            '.ph-sidebar{width:240px;border-right:1px solid #E5E7EB;background:#F9FAFB;display:flex;flex-direction:column;}',
            '.ph-tabs{display:flex;padding:10px 10px 0;gap:4px;}',
            '.ph-tab{flex:1;padding:8px 10px;border:1px solid #E5E7EB;background:#fff;border-radius:8px;cursor:pointer;font-size:0.82rem;font-weight:600;color:#475569;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:6px;}',
            '.ph-tab:hover{border-color:#CBD5E1;}',
            '.ph-tab.active{background:#0F172A;color:#fff;border-color:#0F172A;}',
            '.ph-tab-count{background:rgba(255,255,255,0.18);color:inherit;padding:1px 7px;border-radius:999px;font-size:0.7rem;font-weight:700;}',
            '.ph-tab:not(.active) .ph-tab-count{background:#F1F5F9;color:#64748B;}',
            '.ph-league-list{flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:4px;}',
            '.ph-list-empty{padding:20px 10px;color:#94A3B8;font-size:0.82rem;text-align:center;}',
            '.ph-league-row{text-align:left;border:1px solid transparent;background:transparent;padding:9px 11px;border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:8px;font-family:inherit;color:#0F172A;}',
            '.ph-league-row:hover{background:#F1F5F9;}',
            '.ph-league-row.selected{background:#fff;border-color:#0F172A;box-shadow:0 1px 0 rgba(15,23,42,0.04);}',
            '.ph-league-name{font-weight:600;font-size:0.88rem;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
            '.ph-status{font-size:0.65rem;font-weight:700;padding:3px 8px;border-radius:999px;white-space:nowrap;}',
            '.ph-status-off{background:#F1F5F9;color:#64748B;}',
            '.ph-status-setup{background:#FEF3C7;color:#92400E;}',
            '.ph-status-live{background:#DBEAFE;color:#1E40AF;}',
            '.ph-status-champ{background:#FCD34D;color:#78350F;}',

            // content
            '.ph-content{flex:1;overflow-y:auto;padding:24px 32px;display:flex;flex-direction:column;gap:18px;}',
            '.ph-empty{align-items:center;justify-content:center;color:#64748B;text-align:center;}',
            '.ph-empty-title{font-size:1rem;font-weight:700;color:#0F172A;margin-bottom:4px;}',
            '.ph-empty-sub{font-size:0.85rem;}',

            '.ph-content-head{display:flex;align-items:center;justify-content:space-between;gap:12px;}',
            '.ph-content-title{font-size:1.5rem;font-weight:700;color:#0F172A;letter-spacing:-0.01em;}',
            '.ph-toggle{display:flex;align-items:center;gap:9px;padding:8px 14px;border:1px solid #CBD5E1;border-radius:999px;background:#fff;font-size:0.85rem;font-weight:600;color:#475569;cursor:pointer;user-select:none;}',
            '.ph-toggle.on{background:#0F172A;color:#fff;border-color:#0F172A;}',
            '.ph-toggle input{accent-color:#fff;}',

            '.ph-explainer{padding:12px 14px;background:#F8FAFC;border:1px solid #E5E7EB;border-radius:10px;color:#475569;font-size:0.85rem;line-height:1.5;}',
            '.ph-explainer.subtle{background:transparent;border:none;color:#64748B;font-size:0.82rem;padding:4px 0;}',

            // setup card with steps
            '.ph-setup-card{background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:20px;display:flex;flex-direction:column;gap:18px;}',
            '.ph-step{display:flex;gap:14px;}',
            '.ph-step-num{width:28px;height:28px;border-radius:50%;background:#0F172A;color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:0.85rem;flex-shrink:0;}',
            '.ph-step-body{flex:1;display:flex;flex-direction:column;gap:8px;}',
            '.ph-step-title{font-size:0.95rem;font-weight:700;color:#0F172A;}',
            '.ph-step-sub{font-size:0.78rem;color:#64748B;}',

            '.ph-style-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;}',
            '@media (max-width:760px){.ph-style-row{grid-template-columns:1fr;}}',
            '.ph-pill{text-align:left;padding:12px 14px;border:1px solid #E5E7EB;background:#fff;border-radius:10px;cursor:pointer;font-family:inherit;color:#475569;line-height:1.3;}',
            '.ph-pill strong{display:block;color:#0F172A;font-size:0.92rem;margin-bottom:3px;}',
            '.ph-pill span{font-size:0.78rem;color:#64748B;}',
            '.ph-pill:hover{border-color:#0F172A;}',
            '.ph-pill.active{border-color:#0F172A;background:#0F172A;color:#fff;}',
            '.ph-pill.active strong{color:#fff;}',
            '.ph-pill.active span{color:#CBD5E1;}',

            // setup bar (collapsed)
            '.ph-setup-bar{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#F8FAFC;border:1px solid #E5E7EB;border-radius:10px;flex-wrap:wrap;}',
            '.ph-setup-bar-info{flex:1;display:flex;gap:6px;flex-wrap:wrap;}',
            '.ph-pill-label{padding:4px 10px;background:#fff;border:1px solid #E5E7EB;border-radius:999px;font-size:0.78rem;font-weight:600;color:#475569;}',

            // seeds
            '.ph-seed-wrap{display:flex;flex-direction:column;gap:6px;}',
            '.ph-seed-list{display:flex;flex-direction:column;gap:4px;}',
            '.ph-seed-empty{padding:12px;text-align:center;background:#F8FAFC;border:1px dashed #E5E7EB;border-radius:8px;color:#94A3B8;font-size:0.82rem;}',
            '.ph-seed-row{display:flex;align-items:center;gap:10px;padding:7px 10px;background:#F8FAFC;border:1px solid #E5E7EB;border-radius:8px;cursor:grab;}',
            '.ph-seed-row.dragging{opacity:0.4;}',
            '.ph-seed-row.drag-over{border-color:#0F172A;background:#fff;}',
            '.ph-seed-rank{font-weight:700;font-size:0.78rem;color:#fff;background:#0F172A;min-width:22px;text-align:center;border-radius:6px;padding:2px 0;}',
            '.ph-seed-name{flex:1;font-size:0.88rem;color:#0F172A;}',
            '.ph-seed-btns{display:flex;gap:3px;}',
            '.ph-seed-btns button{width:24px;height:24px;border:1px solid #CBD5E1;background:#fff;border-radius:5px;cursor:pointer;font-size:0.8rem;color:#64748B;line-height:1;font-family:inherit;}',
            '.ph-seed-btns button:hover:not(:disabled){border-color:#0F172A;color:#0F172A;}',
            '.ph-seed-btns button:disabled{opacity:0.3;cursor:default;}',
            '.ph-seed-add{display:flex;gap:6px;}',
            '.ph-seed-add select{flex:1;padding:7px 10px;border:1px solid #CBD5E1;border-radius:6px;font-size:0.82rem;background:#fff;font-family:inherit;}',

            // actions / buttons
            '.ph-actions-row{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;}',
            '.ph-btn{padding:9px 18px;border:1px solid #CBD5E1;background:#fff;border-radius:8px;cursor:pointer;font-size:0.88rem;font-weight:600;font-family:inherit;color:#0F172A;}',
            '.ph-btn:hover:not(:disabled){background:#F1F5F9;border-color:#0F172A;}',
            '.ph-btn.primary{background:#0F172A;color:#fff;border-color:#0F172A;}',
            '.ph-btn.primary:hover:not(:disabled){background:#1E293B;}',
            '.ph-btn.primary.big{padding:12px 28px;font-size:0.95rem;}',
            '.ph-btn.ghost{background:transparent;}',
            '.ph-btn.small{padding:6px 12px;font-size:0.78rem;}',
            '.ph-btn.danger{color:#B91C1C;}',
            '.ph-btn.danger:hover:not(:disabled){background:#FEF2F2;border-color:#FECACA;}',
            '.ph-btn:disabled{opacity:0.4;cursor:default;}',

            // bracket
            '.ph-bracket-wrap{background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:18px;display:flex;flex-direction:column;gap:10px;}',
            '.ph-bracket{display:flex;gap:18px;overflow-x:auto;padding:6px 2px 14px;}',
            '.ph-round-col{display:flex;flex-direction:column;gap:10px;min-width:240px;}',
            '.ph-round-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 2px;}',
            '.ph-round-num{font-size:0.78rem;font-weight:700;color:#0F172A;text-transform:uppercase;letter-spacing:0.06em;}',
            '.ph-round-status{font-size:0.65rem;font-weight:700;padding:3px 8px;border-radius:999px;background:#DCFCE7;color:#166534;text-transform:uppercase;letter-spacing:0.04em;}',

            '.ph-matchup{background:#F8FAFC;border:1px solid #E5E7EB;border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:6px;}',
            '.ph-matchup.decided{border-color:#0F172A;background:#fff;}',
            '.ph-matchup.bye{opacity:0.6;}',
            '.ph-team{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid #CBD5E1;background:#fff;border-radius:7px;cursor:pointer;font-family:inherit;font-size:0.85rem;color:#0F172A;text-align:left;}',
            '.ph-team:hover:not(:disabled){border-color:#0F172A;}',
            '.ph-team.winner{background:#0F172A;color:#fff;border-color:#0F172A;font-weight:700;}',
            '.ph-team.bye{background:#F1F5F9;color:#94A3B8;font-style:italic;}',
            '.ph-team:disabled{cursor:default;}',
            '.ph-team-seed{font-size:0.7rem;color:#64748B;font-weight:700;min-width:30px;}',
            '.ph-team.winner .ph-team-seed{color:#94A3B8;}',
            '.ph-team-name{flex:1;}',
            '.ph-team-check{font-weight:700;}',
            '.ph-vs{font-size:0.65rem;color:#94A3B8;text-align:center;text-transform:uppercase;letter-spacing:0.06em;}',
            '.ph-bye-note{font-size:0.72rem;color:#94A3B8;font-style:italic;text-align:center;padding:4px 0;}',
            '.ph-pickrow{display:flex;align-items:center;gap:8px;font-size:0.75rem;}',
            '.ph-pickrow-label{color:#64748B;font-weight:600;min-width:38px;}',
            '.ph-pickrow select{flex:1;padding:5px 8px;border:1px solid #CBD5E1;border-radius:6px;font-size:0.78rem;background:#fff;font-family:inherit;}',

            // champion
            '.ph-champion{background:#0F172A;color:#fff;border-radius:12px;padding:22px 16px;text-align:center;}',
            '.ph-champion-label{font-size:0.7rem;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#94A3B8;}',
            '.ph-champion-name{font-size:1.6rem;font-weight:800;margin-top:6px;}',

            // reservations
            '.ph-reserved-card{background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;}',
            '.ph-reserved-head{display:flex;flex-direction:column;gap:2px;}',
            '.ph-reserved-title{font-size:0.85rem;font-weight:700;color:#0F172A;}',
            '.ph-reserved-sub{font-size:0.78rem;color:#64748B;line-height:1.45;}',
            '.ph-chips{display:flex;flex-wrap:wrap;gap:6px;}',
            '.ph-chip{padding:5px 12px;background:#F8FAFC;border:1px solid #E5E7EB;border-radius:999px;font-size:0.78rem;color:#475569;cursor:pointer;font-family:inherit;}',
            '.ph-chip:hover{border-color:#0F172A;color:#0F172A;}',
            '.ph-chip.active{background:#0F172A;color:#fff;border-color:#0F172A;}'
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
