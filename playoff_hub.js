// =============================================================================
// playoff_hub.js — per-league dedicated UI for managing one playoff bracket
// =============================================================================
// Open with PlayoffHub.open(league, kind) where kind = 'regular' | 'specialty'.
// One overlay manages one league at a time — there's no sidebar; each league's
// "Playoff Mode" button launches its own focused hub.
//
// Step layout:
//   Step 1 — Choose bracket style       (only when no rounds exist yet)
//   Step 2 — Create matchups            (seeds + bracket + advance)
//   Step 3 — Reserve activities         (chips for non-playing kids)
//
// Public API: window.PlayoffHub
//   .open(league, kind)
//   .close()
// =============================================================================
(function () {
    'use strict';

    var VERSION = '3.0.0';
    var _overlayEl = null;
    var _league = null;
    var _kind = 'regular';
    var _editStyleAfterRounds = false;  // when true, show Step 1 even though rounds exist

    function escHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // -------------------------------------------------------------------------
    // Persistence
    // -------------------------------------------------------------------------
    function _save() {
        if (_kind === 'specialty') {
            var sl = window.specialtyLeagues || {};
            if (typeof window.saveGlobalSettings === 'function') {
                try { window.saveGlobalSettings('specialtyLeagues', sl); } catch (_) {}
            }
        } else {
            var lbn = window.leaguesByName || {};
            if (typeof window.saveGlobalSettings === 'function') {
                try { window.saveGlobalSettings('leaguesByName', lbn); } catch (_) {}
            }
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
        var hasRounds = p.enabled && p.rounds && p.rounds.length > 0;

        // Top row: enable toggle (and a back-from-edit-style hint if applicable)
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
            _editStyleAfterRounds = false;
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
            off.textContent = 'Turn on Playoff to override regular round-robin scheduling with a single-elimination bracket. Each matchup gets its own sport + field, and the scheduler advances winners round by round.';
            body.appendChild(off);
            return;
        }

        // Step 1 — first-time only OR when user clicks "Edit bracket style"
        if (!hasRounds || _editStyleAfterRounds) {
            body.appendChild(_renderStep1(p));
        } else {
            body.appendChild(_renderStyleSummary(p));
        }

        // Step 2 — Create matchups (always shown when enabled)
        body.appendChild(_renderStep2(p));

        // Step 3 — Reserve activities
        body.appendChild(_renderStep3(p));
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

    function _renderStep1(p) {
        var card = document.createElement('section');
        card.className = 'ph-step-card';
        card.appendChild(_stepHead(1, 'Choose bracket style', 'How are winners paired in each round?'));

        var row = document.createElement('div');
        row.className = 'ph-style-row';
        [
            { v: 'fixed',  t: 'Fixed bracket', d: 'NBA-style. 1v8 winner plays 4v5 winner.' },
            { v: 'reseed', t: 'Re-seed',       d: 'Top remaining seed always plays the bottom.' }
        ].forEach(function (opt) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ph-pill' + (p.style === opt.v ? ' active' : '');
            btn.innerHTML = '<strong>' + escHtml(opt.t) + '</strong><span>' + escHtml(opt.d) + '</span>';
            btn.onclick = function () {
                p.style = opt.v;
                _save();
                _render();
            };
            row.appendChild(btn);
        });
        card.appendChild(row);

        // Confirm bracket-style edit when rounds already exist
        if (p.rounds && p.rounds.length > 0 && _editStyleAfterRounds) {
            var hint = document.createElement('div');
            hint.className = 'ph-explainer subtle';
            hint.textContent = 'Changing bracket style won\'t affect existing rounds — only future advances. Click Done when finished.';
            card.appendChild(hint);

            var done = document.createElement('button');
            done.type = 'button';
            done.className = 'ph-btn ghost';
            done.textContent = 'Done';
            done.onclick = function () { _editStyleAfterRounds = false; _render(); };
            card.appendChild(done);
        }
        return card;
    }

    function _renderStyleSummary(p) {
        var bar = document.createElement('div');
        bar.className = 'ph-style-summary';
        var label = (p.style === 'reseed') ? 'Re-seed (top vs bottom)' : 'Fixed bracket (NBA-style)';
        bar.innerHTML = '<span class="ph-style-summary-label">Bracket style</span>'
            + '<span class="ph-style-summary-value">' + escHtml(label) + '</span>';
        var edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'ph-btn ghost small';
        edit.textContent = 'Edit';
        edit.onclick = function () { _editStyleAfterRounds = true; _render(); };
        bar.appendChild(edit);
        return bar;
    }

    function _renderStep2(p) {
        var hasRounds = p.rounds && p.rounds.length > 0;

        var card = document.createElement('section');
        card.className = 'ph-step-card';
        card.appendChild(_stepHead(2, 'Create matchups',
            hasRounds ? 'Pick a winner for each matchup. When the round is complete, generate the next one.'
                      : 'Set the seed order, then generate Round 1.'));

        // Seeds editor (always — top of step 2)
        var seedsLabel = document.createElement('div');
        seedsLabel.className = 'ph-step-section-label';
        seedsLabel.textContent = 'Seeds (1 = top seed)';
        card.appendChild(seedsLabel);
        card.appendChild(_renderSeedList(p));

        // Generate Round 1 / Regenerate button (only when no rounds OR seeds changed since)
        if (!hasRounds) {
            var actions = document.createElement('div');
            actions.className = 'ph-actions-row center';
            var genBtn = document.createElement('button');
            genBtn.type = 'button';
            genBtn.className = 'ph-btn primary big';
            genBtn.textContent = 'Generate Round 1';
            genBtn.disabled = (p.seedOrder || []).length < 2;
            genBtn.onclick = function () {
                var r1 = window.PlayoffMode.generateRound1(p.seedOrder, p.style);
                p.rounds = [{ number: 1, matchups: r1 }];
                p.currentRound = 1;
                _save();
                _render();
            };
            actions.appendChild(genBtn);
            card.appendChild(actions);
        } else {
            // Bracket
            var bracketLabel = document.createElement('div');
            bracketLabel.className = 'ph-step-section-label';
            bracketLabel.textContent = 'Bracket';
            card.appendChild(bracketLabel);
            card.appendChild(_renderBracket(p));

            // Action row: Regenerate (with confirm) + Advance/Champion
            var lastRound = p.rounds[p.rounds.length - 1];
            var roundComplete = window.PlayoffMode.isRoundComplete(lastRound);
            var nonByeWinners = (lastRound.matchups || []).filter(function (m) { return m && m.winner && m.winner !== 'BYE'; }).length;
            var isChampion = lastRound.matchups && lastRound.matchups.length === 1 && lastRound.matchups[0].winner;

            if (isChampion) {
                var champ = document.createElement('div');
                champ.className = 'ph-champion';
                champ.innerHTML = '<div class="ph-champion-label">Champion</div>'
                    + '<div class="ph-champion-name">' + escHtml(lastRound.matchups[0].winner) + '</div>';
                card.appendChild(champ);
            } else if (roundComplete && nonByeWinners >= 2) {
                var advRow = document.createElement('div');
                advRow.className = 'ph-actions-row center';
                var advBtn = document.createElement('button');
                advBtn.type = 'button';
                advBtn.className = 'ph-btn primary big';
                advBtn.textContent = 'Generate Round ' + (lastRound.number + 1);
                advBtn.onclick = function () {
                    var nextMatchups = (p.style === 'reseed')
                        ? window.PlayoffMode.advanceReseed(lastRound, p.seedOrder)
                        : window.PlayoffMode.advanceFixed(lastRound);
                    p.rounds.push({ number: lastRound.number + 1, matchups: nextMatchups });
                    p.currentRound = lastRound.number + 1;
                    _save();
                    _render();
                };
                advRow.appendChild(advBtn);
                card.appendChild(advRow);
            } else if (lastRound.matchups && lastRound.matchups.length > 0) {
                var todo = (lastRound.matchups || []).filter(function (m) { return m && !m.winner && !m.isBye; }).length;
                if (todo > 0) {
                    var hint = document.createElement('div');
                    hint.className = 'ph-explainer subtle';
                    hint.textContent = todo + ' matchup' + (todo === 1 ? '' : 's') + ' still need a winner. Click a team to mark it.';
                    card.appendChild(hint);
                }
            }

            // Bottom action: Clear bracket (subtle, danger)
            var bottom = document.createElement('div');
            bottom.className = 'ph-actions-row';
            var clearBtn = document.createElement('button');
            clearBtn.type = 'button';
            clearBtn.className = 'ph-btn ghost small danger';
            clearBtn.textContent = 'Clear bracket & start over';
            clearBtn.onclick = function () {
                if (!confirm('Clear the entire bracket for ' + (_league.name || 'this league') + '?')) return;
                p.rounds = []; p.currentRound = 1;
                _save(); _render();
            };
            bottom.appendChild(clearBtn);
            card.appendChild(bottom);
        }

        return card;
    }

    function _renderSeedList(p) {
        var teams = (_league.teams || []).slice();
        // Drop dead seeds
        p.seedOrder = (p.seedOrder || []).filter(function (t) { return teams.indexOf(t) >= 0; });

        // Auto-seed from standings if empty
        if (p.seedOrder.length === 0 && _league.standings) {
            var keys = Object.keys(_league.standings);
            if (keys.length > 0) {
                var sorted = keys.slice().sort(function (a, b) {
                    var sa = _league.standings[a], sb = _league.standings[b];
                    var wa = (sa.w || 0), wb = (sb.w || 0);
                    if (wb !== wa) return wb - wa;
                    var diffA = (sa.w || 0) - (sa.l || 0), diffB = (sb.w || 0) - (sb.l || 0);
                    if (diffB !== diffA) return diffB - diffA;
                    return a.localeCompare(b);
                });
                teams.forEach(function (t) { if (sorted.indexOf(t) === -1) sorted.push(t); });
                p.seedOrder = sorted;
                _save();
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
                    _save(); _render();
                };
                var down = document.createElement('button');
                down.type = 'button'; down.textContent = '↓'; down.disabled = idx === p.seedOrder.length - 1;
                down.onclick = function () {
                    var t = p.seedOrder[idx + 1]; p.seedOrder[idx + 1] = p.seedOrder[idx]; p.seedOrder[idx] = t;
                    _save(); _render();
                };
                var rm = document.createElement('button');
                rm.type = 'button'; rm.textContent = '×'; rm.title = 'Remove from seeds';
                rm.onclick = function () {
                    p.seedOrder = p.seedOrder.filter(function (x) { return x !== team; });
                    _save(); _render();
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
                    _save(); _render();
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
                _save(); _render();
            };
            addRow.appendChild(sel);

            if (unseeded.length > 1) {
                var allBtn = document.createElement('button');
                allBtn.type = 'button';
                allBtn.className = 'ph-btn ghost small';
                allBtn.textContent = 'Add all';
                allBtn.onclick = function () {
                    unseeded.forEach(function (t) { p.seedOrder.push(t); });
                    _save(); _render();
                };
                addRow.appendChild(allBtn);
            }
            wrap.appendChild(addRow);
        }
        return wrap;
    }

    function _renderBracket(p) {
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

            (round.matchups || []).forEach(function (m) {
                col.appendChild(_renderMatchup(p, round, m, isSettled));
            });

            bracket.appendChild(col);
        });

        wrap.appendChild(bracket);
        return wrap;
    }

    function _renderMatchup(p, round, m, isSettled) {
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
                _save();
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
            + ((_league.sports || []) || []).map(function (s) {
                return '<option value="' + escHtml(s) + '"' + (m.sport === s ? ' selected' : '') + '>' + escHtml(s) + '</option>';
            }).join('');
        sportSel.onchange = function () {
            m.sport = sportSel.value;
            if (m.field && _fieldsForSport(m.sport).indexOf(m.field) < 0) m.field = '';
            _save(); _render();
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
            _save();
        };
        fieldRow.appendChild(fieldSel);
        box.appendChild(fieldRow);

        return box;
    }

    function _renderStep3(p) {
        var card = document.createElement('section');
        card.className = 'ph-step-card';
        card.appendChild(_stepHead(3, 'Reserve activities for non-playing kids',
            'Locked during the playoff slot for ' + ((_league.divisions || []).join(', ') || 'this league\'s grades') + ' so the auto-scheduler routes eliminated/not-playing bunks into them.'));

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
        _editStyleAfterRounds = false;

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
            '.ph-step-section-label{font-size:0.72rem;font-weight:700;color:#147D91;text-transform:uppercase;letter-spacing:0.06em;margin-left:42px;}',

            // Style summary (collapsed step 1 after rounds exist)
            '.ph-style-summary{display:flex;align-items:center;gap:10px;padding:9px 14px;background:#F9FAFB;border:1px solid #E5E7EB;border-radius:10px;}',
            '.ph-style-summary-label{font-size:0.7rem;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:0.06em;}',
            '.ph-style-summary-value{flex:1;font-size:0.88rem;font-weight:600;color:#0A4A56;}',

            '.ph-style-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-left:42px;}',
            '@media (max-width:720px){.ph-style-row{grid-template-columns:1fr;margin-left:0;}}',
            '.ph-pill{text-align:left;padding:12px 14px;border:1px solid #E5E7EB;background:#fff;border-radius:10px;cursor:pointer;font-family:inherit;color:#475569;line-height:1.3;}',
            '.ph-pill strong{display:block;color:#0A4A56;font-size:0.92rem;margin-bottom:3px;}',
            '.ph-pill span{font-size:0.78rem;color:#6B7280;}',
            '.ph-pill:hover{border-color:#147D91;}',
            '.ph-pill.active{border-color:#147D91;background:#147D91;color:#fff;}',
            '.ph-pill.active strong{color:#fff;}',
            '.ph-pill.active span{color:#A5F3FC;}',

            // Seeds
            '.ph-seed-wrap{display:flex;flex-direction:column;gap:6px;margin-left:42px;}',
            '@media (max-width:720px){.ph-seed-wrap{margin-left:0;}}',
            '.ph-seed-list{display:flex;flex-direction:column;gap:4px;}',
            '.ph-seed-empty{padding:12px;text-align:center;background:#F9FAFB;border:1px dashed #E5E7EB;border-radius:8px;color:#9CA3AF;font-size:0.82rem;}',
            '.ph-seed-row{display:flex;align-items:center;gap:10px;padding:7px 10px;background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;cursor:grab;}',
            '.ph-seed-row.dragging{opacity:0.4;}',
            '.ph-seed-row.drag-over{border-color:#147D91;background:#ECFEFF;}',
            '.ph-seed-rank{font-weight:700;font-size:0.78rem;color:#fff;background:#147D91;min-width:22px;text-align:center;border-radius:6px;padding:2px 0;}',
            '.ph-seed-name{flex:1;font-size:0.88rem;color:#0A4A56;}',
            '.ph-seed-btns{display:flex;gap:3px;}',
            '.ph-seed-btns button{width:24px;height:24px;border:1px solid #CBD5E1;background:#fff;border-radius:5px;cursor:pointer;font-size:0.8rem;color:#6B7280;line-height:1;font-family:inherit;}',
            '.ph-seed-btns button:hover:not(:disabled){border-color:#147D91;color:#147D91;}',
            '.ph-seed-btns button:disabled{opacity:0.3;cursor:default;}',
            '.ph-seed-add{display:flex;gap:6px;}',
            '.ph-seed-add select{flex:1;padding:7px 10px;border:1px solid #CBD5E1;border-radius:6px;font-size:0.82rem;background:#fff;font-family:inherit;}',

            // Actions / buttons
            '.ph-actions-row{display:flex;gap:8px;flex-wrap:wrap;}',
            '.ph-actions-row.center{justify-content:center;}',
            '.ph-btn{padding:9px 18px;border:1px solid #CBD5E1;background:#fff;border-radius:8px;cursor:pointer;font-size:0.88rem;font-weight:600;font-family:inherit;color:#0A4A56;}',
            '.ph-btn:hover:not(:disabled){background:#F1F5F9;border-color:#147D91;color:#147D91;}',
            '.ph-btn.primary{background:#147D91;color:#fff;border-color:#147D91;}',
            '.ph-btn.primary:hover:not(:disabled){background:#0F6E80;color:#fff;}',
            '.ph-btn.primary.big{padding:12px 28px;font-size:0.95rem;}',
            '.ph-btn.ghost{background:transparent;}',
            '.ph-btn.small{padding:6px 12px;font-size:0.78rem;}',
            '.ph-btn.danger{color:#B91C1C;}',
            '.ph-btn.danger:hover:not(:disabled){background:#FEF2F2;border-color:#FECACA;}',
            '.ph-btn:disabled{opacity:0.4;cursor:default;}',

            // Bracket
            '.ph-bracket-wrap{margin-left:42px;}',
            '@media (max-width:720px){.ph-bracket-wrap{margin-left:0;}}',
            '.ph-bracket{display:flex;gap:18px;overflow-x:auto;padding:6px 2px 14px;}',
            '.ph-round-col{display:flex;flex-direction:column;gap:10px;min-width:240px;}',
            '.ph-round-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 2px;}',
            '.ph-round-num{font-size:0.78rem;font-weight:700;color:#0A4A56;text-transform:uppercase;letter-spacing:0.06em;}',
            '.ph-round-status{font-size:0.65rem;font-weight:700;padding:3px 8px;border-radius:999px;background:#D1FAE5;color:#065F46;text-transform:uppercase;letter-spacing:0.04em;}',

            '.ph-matchup{background:#F9FAFB;border:1px solid #E5E7EB;border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:6px;}',
            '.ph-matchup.decided{border-color:#147D91;background:#fff;}',
            '.ph-matchup.bye{opacity:0.6;}',
            '.ph-team{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid #CBD5E1;background:#fff;border-radius:7px;cursor:pointer;font-family:inherit;font-size:0.85rem;color:#0A4A56;text-align:left;}',
            '.ph-team:hover:not(:disabled){border-color:#147D91;}',
            '.ph-team.winner{background:#147D91;color:#fff;border-color:#147D91;font-weight:700;}',
            '.ph-team.bye{background:#F1F5F9;color:#9CA3AF;font-style:italic;}',
            '.ph-team:disabled{cursor:default;}',
            '.ph-team-seed{font-size:0.7rem;color:#6B7280;font-weight:700;min-width:30px;}',
            '.ph-team.winner .ph-team-seed{color:#A5F3FC;}',
            '.ph-team-name{flex:1;}',
            '.ph-team-check{font-weight:700;}',
            '.ph-vs{font-size:0.65rem;color:#9CA3AF;text-align:center;text-transform:uppercase;letter-spacing:0.06em;}',
            '.ph-bye-note{font-size:0.72rem;color:#9CA3AF;font-style:italic;text-align:center;padding:4px 0;}',
            '.ph-pickrow{display:flex;align-items:center;gap:8px;font-size:0.75rem;}',
            '.ph-pickrow-label{color:#6B7280;font-weight:600;min-width:38px;}',
            '.ph-pickrow select{flex:1;padding:5px 8px;border:1px solid #CBD5E1;border-radius:6px;font-size:0.78rem;background:#fff;font-family:inherit;}',

            // Champion
            '.ph-champion{background:#147D91;color:#fff;border-radius:12px;padding:22px 16px;text-align:center;margin-left:42px;}',
            '@media (max-width:720px){.ph-champion{margin-left:0;}}',
            '.ph-champion-label{font-size:0.7rem;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#A5F3FC;}',
            '.ph-champion-name{font-size:1.6rem;font-weight:800;margin-top:6px;}',

            // Reservations
            '.ph-chips{display:flex;flex-wrap:wrap;gap:6px;margin-left:42px;}',
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
