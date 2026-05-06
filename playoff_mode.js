// =============================================================================
// playoff_mode.js — shared playoff/bracket module for Leagues + Specialty Leagues
// =============================================================================
// Adds a `playoff` sub-object to each league/specialty-league:
//   league.playoff = {
//     enabled: bool,
//     style: 'fixed' | 'reseed',
//     seedOrder: [teamName, ...],         // 1=top seed
//     rounds: [
//       { number: 1, matchups: [
//           { id, teamA, teamB, sport, winner: null }
//       ]}
//     ],
//     reservedActivities: [activityName, ...],   // facilities saved for non-playoff slots
//     currentRound: 1
//   }
//
// Public API: window.PlayoffMode
//   generateRound1(seedOrder, style)   - bracket-position pairings + byes
//   advanceFixed(prevRound)            - pair winners by bracket adjacency
//   advanceReseed(prevRounds, seedOrder) - re-seed remaining winners top-vs-bottom
//   getActiveRound(league)             - returns the round object with un-decided matchups
//   getActiveMatchups(league)          - matchups whose teams are both alive (no BYE)
//   isLeagueInPlayoff(league)          - convenience guard
//   render(league, mountEl, opts)      - paints the UI into mountEl
// =============================================================================
(function () {
    'use strict';

    var VERSION = '1.0.0';

    // -------------------------------------------------------------------------
    // Pure helpers
    // -------------------------------------------------------------------------

    function escHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function uid() {
        return 'mu_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    }

    function nextPowerOf2(n) {
        var p = 1;
        while (p < n) p *= 2;
        return p;
    }

    // Standard playoff bracket positions for size N (power of 2):
    //   N=2 -> [[1,2]]
    //   N=4 -> [[1,4],[2,3]]
    //   N=8 -> [[1,8],[4,5],[3,6],[2,7]]
    // Generated recursively so that fixed-bracket adjacency works:
    // adjacent matchups in the returned array meet in the next round.
    function bracketPositions(size) {
        if (size === 1) return [[1]];
        if (size === 2) return [[1, 2]];
        var prev = bracketPositions(size / 2);
        var out = [];
        prev.forEach(function (pair) {
            var hi = pair[0], lo = pair[1];
            // Each previous "match" splits into two in this size:
            // (hi vs size+1-hi) on the high side, (size+1-lo vs lo) on the low side.
            // The two new matches must be adjacent so their winners meet in next round.
            out.push([hi, size + 1 - hi]);
            out.push([size + 1 - lo, lo]);
        });
        return out;
    }

    // From a seedOrder array (1-indexed by position), produce Round-1 matchups
    // for the given style. Handles non-power-of-2 by padding with BYE entries
    // (top seeds get the byes).
    function generateRound1(seedOrder, style) {
        var teams = (seedOrder || []).slice();
        var n = teams.length;
        if (n < 2) return [];

        var size = nextPowerOf2(n);
        // Pad with BYEs so the high-seed positions face byes
        while (teams.length < size) teams.push('BYE');

        var positions = bracketPositions(size);
        var matchups = [];
        positions.forEach(function (pair) {
            var seedA = pair[0], seedB = pair[1];
            var teamA = teams[seedA - 1] || 'BYE';
            var teamB = teams[seedB - 1] || 'BYE';
            var winner = null;
            // Auto-advance if exactly one side is a BYE
            if (teamA === 'BYE' && teamB !== 'BYE') winner = teamB;
            else if (teamB === 'BYE' && teamA !== 'BYE') winner = teamA;
            matchups.push({
                id: uid(),
                teamA: teamA,
                teamB: teamB,
                seedA: seedA,
                seedB: seedB,
                sport: '',
                winner: winner,
                isBye: (teamA === 'BYE' || teamB === 'BYE')
            });
        });
        return matchups;
    }

    // Fixed-bracket: round N+1 pairs winners of adjacent matchups in round N.
    function advanceFixed(prevRound) {
        if (!prevRound || !prevRound.matchups) return [];
        var winners = prevRound.matchups.map(function (m) { return m.winner; });
        var out = [];
        for (var i = 0; i < winners.length; i += 2) {
            var a = winners[i] || null;
            var b = winners[i + 1] || null;
            if (!a && !b) continue;
            // Carry forward seed metadata if available
            var prevA = prevRound.matchups[i];
            var prevB = prevRound.matchups[i + 1];
            var seedA = pickWinningSeed(prevA);
            var seedB = pickWinningSeed(prevB);
            var winner = null;
            if (a && !b) winner = a;
            else if (b && !a) winner = b;
            out.push({
                id: uid(),
                teamA: a || 'BYE',
                teamB: b || 'BYE',
                seedA: seedA,
                seedB: seedB,
                sport: '',
                winner: winner,
                isBye: (!a || !b)
            });
        }
        return out;
    }

    function pickWinningSeed(matchup) {
        if (!matchup) return null;
        if (matchup.winner === matchup.teamA) return matchup.seedA;
        if (matchup.winner === matchup.teamB) return matchup.seedB;
        return null;
    }

    // Re-seed: collect surviving teams (winners of last round), look up their
    // original seed rank from seedOrder, sort ascending, then pair top vs bottom.
    function advanceReseed(prevRound, seedOrder) {
        if (!prevRound || !prevRound.matchups) return [];
        var winners = prevRound.matchups.map(function (m) { return m.winner; }).filter(Boolean);
        if (winners.length < 2) return [];
        // Map team -> original seed (1-indexed)
        var seedRank = {};
        (seedOrder || []).forEach(function (t, i) { seedRank[t] = i + 1; });
        // Sort winners by their original seed (best seed first)
        var sorted = winners.slice().sort(function (a, b) {
            return (seedRank[a] || 9999) - (seedRank[b] || 9999);
        });
        var out = [];
        var lo = 0, hi = sorted.length - 1;
        while (lo < hi) {
            var teamA = sorted[lo], teamB = sorted[hi];
            out.push({
                id: uid(),
                teamA: teamA,
                teamB: teamB,
                seedA: seedRank[teamA] || null,
                seedB: seedRank[teamB] || null,
                sport: '',
                winner: null,
                isBye: false
            });
            lo++; hi--;
        }
        // Odd team gets a bye (auto-advances)
        if (lo === hi) {
            out.push({
                id: uid(),
                teamA: sorted[lo],
                teamB: 'BYE',
                seedA: seedRank[sorted[lo]] || null,
                seedB: null,
                sport: '',
                winner: sorted[lo],
                isBye: true
            });
        }
        return out;
    }

    // -------------------------------------------------------------------------
    // State accessors
    // -------------------------------------------------------------------------

    function getOrInit(league) {
        if (!league.playoff || typeof league.playoff !== 'object') {
            league.playoff = {
                enabled: false,
                style: 'fixed',
                seedOrder: [],
                rounds: [],
                reservedActivities: [],
                currentRound: 1
            };
        }
        // Migration: ensure all fields present
        var p = league.playoff;
        if (typeof p.enabled !== 'boolean') p.enabled = false;
        if (p.style !== 'reseed') p.style = 'fixed';
        if (!Array.isArray(p.seedOrder)) p.seedOrder = [];
        if (!Array.isArray(p.rounds)) p.rounds = [];
        if (!Array.isArray(p.reservedActivities)) p.reservedActivities = [];
        if (typeof p.currentRound !== 'number' || p.currentRound < 1) p.currentRound = 1;
        return p;
    }

    function isLeagueInPlayoff(league) {
        return !!(league && league.playoff && league.playoff.enabled
            && Array.isArray(league.playoff.rounds) && league.playoff.rounds.length > 0);
    }

    function getActiveRound(league) {
        if (!isLeagueInPlayoff(league)) return null;
        var p = league.playoff;
        var idx = Math.min(Math.max(p.currentRound - 1, 0), p.rounds.length - 1);
        return p.rounds[idx] || null;
    }

    function getActiveMatchups(league) {
        var r = getActiveRound(league);
        if (!r || !r.matchups) return [];
        return r.matchups.filter(function (m) {
            return m && m.teamA && m.teamB
                && m.teamA !== 'BYE' && m.teamB !== 'BYE'
                && !m.winner;
        });
    }

    function isRoundComplete(round) {
        if (!round || !round.matchups || !round.matchups.length) return false;
        // A round is complete when every non-bye matchup has a winner.
        return round.matchups.every(function (m) {
            if (!m) return false;
            if (m.isBye || m.teamA === 'BYE' || m.teamB === 'BYE') return !!m.winner;
            return !!m.winner;
        });
    }

    // -------------------------------------------------------------------------
    // UI rendering
    // -------------------------------------------------------------------------

    // opts:
    //   onSave: function() -> persists league mutation
    //   getSports: function() -> string[] sports allowed for this league
    //                          (defaults to league.sports)
    //   getActivities: function() -> string[] all activities/fields available
    //                                for the reserved-activities multi-select
    //   readOnly: bool
    function render(league, mountEl, opts) {
        opts = opts || {};
        if (!mountEl) return;
        var p = getOrInit(league);
        var save = opts.onSave || function () { };

        // ── AUTO-SEED FROM STANDINGS ──
        // When the seed list is empty and the league has recorded standings,
        // pre-populate seedOrder by sorting teams: W desc → W-L diff desc → alpha.
        // Teams present in league.teams but absent from standings are appended at the end.
        if (!opts.readOnly && p.seedOrder.length === 0 && league.standings) {
            var _stKeys = Object.keys(league.standings);
            if (_stKeys.length > 0) {
                var _sorted = _stKeys.slice().sort(function (a, b) {
                    var sa = league.standings[a], sb = league.standings[b];
                    var wa = (sa.w || 0), wb = (sb.w || 0);
                    if (wb !== wa) return wb - wa;
                    var diffA = (sa.w || 0) - (sa.l || 0), diffB = (sb.w || 0) - (sb.l || 0);
                    if (diffB !== diffA) return diffB - diffA;
                    return a.localeCompare(b);
                });
                // Append any league.teams entries not already in standings
                var _allTeams = league.teams || [];
                _allTeams.forEach(function (t) {
                    if (_sorted.indexOf(t) === -1) _sorted.push(t);
                });
                p.seedOrder = _sorted;
                save();
            }
        }

        var sportsList = (opts.getSports ? opts.getSports() : null) || (league.sports || []);
        var activitiesList = (opts.getActivities ? opts.getActivities() : null) || [];
        var readOnly = !!opts.readOnly;

        mountEl.innerHTML = '';
        mountEl.classList.add('playoff-mount');

        // ── HEADER: enable toggle + style picker ──
        var header = document.createElement('div');
        header.className = 'playoff-header';

        var title = document.createElement('div');
        title.className = 'playoff-title';
        title.textContent = 'Playoff Mode';

        var enableLabel = document.createElement('label');
        enableLabel.className = 'playoff-enable';
        var enableCb = document.createElement('input');
        enableCb.type = 'checkbox';
        enableCb.checked = !!p.enabled;
        enableCb.disabled = readOnly;
        enableCb.onchange = function () {
            p.enabled = enableCb.checked;
            save();
            render(league, mountEl, opts);
        };
        enableLabel.appendChild(enableCb);
        enableLabel.appendChild(document.createTextNode(' Enable'));

        header.appendChild(title);
        header.appendChild(enableLabel);
        mountEl.appendChild(header);

        if (!p.enabled) {
            var hint = document.createElement('div');
            hint.className = 'playoff-hint';
            hint.textContent = 'Turn on Playoff Mode to override regular round-robin scheduling with a single-elimination bracket. Each matchup gets its own sport, and the scheduler advances winners round-by-round.';
            mountEl.appendChild(hint);
            return;
        }

        // ── STYLE PICKER ──
        var styleCard = document.createElement('div');
        styleCard.className = 'playoff-card';

        var styleHead = document.createElement('div');
        styleHead.className = 'playoff-card-head';
        styleHead.textContent = 'Bracket style';
        styleCard.appendChild(styleHead);

        var styleRow = document.createElement('div');
        styleRow.className = 'playoff-style-row';

        var fixedBtn = document.createElement('button');
        fixedBtn.type = 'button';
        fixedBtn.className = 'playoff-pill' + (p.style === 'fixed' ? ' active' : '');
        fixedBtn.disabled = readOnly;
        fixedBtn.innerHTML = '<strong>Fixed bracket</strong><br><span>NBA-style — 1v8 winner plays 4v5 winner.</span>';
        fixedBtn.onclick = function () { p.style = 'fixed'; save(); render(league, mountEl, opts); };

        var reseedBtn = document.createElement('button');
        reseedBtn.type = 'button';
        reseedBtn.className = 'playoff-pill' + (p.style === 'reseed' ? ' active' : '');
        reseedBtn.disabled = readOnly;
        reseedBtn.innerHTML = '<strong>Re-seed</strong><br><span>Top remaining seed always plays the bottom.</span>';
        reseedBtn.onclick = function () { p.style = 'reseed'; save(); render(league, mountEl, opts); };

        styleRow.appendChild(fixedBtn);
        styleRow.appendChild(reseedBtn);
        styleCard.appendChild(styleRow);
        mountEl.appendChild(styleCard);

        // ── SEED LIST ──
        var seedCard = document.createElement('div');
        seedCard.className = 'playoff-card';

        var seedHead = document.createElement('div');
        seedHead.className = 'playoff-card-head';
        seedHead.textContent = 'Seeds (1 = top)';
        seedCard.appendChild(seedHead);

        var seedHint = document.createElement('div');
        seedHint.className = 'playoff-card-sub';
        seedHint.textContent = 'Drag to re-order, or use ▲ / ▼. Non-power-of-2 brackets get byes for the top seeds.';
        seedCard.appendChild(seedHint);

        renderSeedList(seedCard, league, save, opts);
        mountEl.appendChild(seedCard);

        // ── GENERATE ROUND 1 ──
        var actionsRow = document.createElement('div');
        actionsRow.className = 'playoff-actions-row';

        var genBtn = document.createElement('button');
        genBtn.type = 'button';
        genBtn.className = 'playoff-btn primary';
        genBtn.textContent = (p.rounds && p.rounds.length > 0)
            ? 'Regenerate bracket from seeds'
            : 'Generate Round 1';
        genBtn.disabled = readOnly || (p.seedOrder || []).length < 2;
        genBtn.onclick = function () {
            if (p.rounds.length > 0 && !confirm('This will discard existing rounds and winners. Continue?')) return;
            var r1 = generateRound1(p.seedOrder, p.style);
            p.rounds = [{ number: 1, matchups: r1 }];
            p.currentRound = 1;
            save();
            render(league, mountEl, opts);
        };
        actionsRow.appendChild(genBtn);

        if (p.rounds.length > 0) {
            var resetBtn = document.createElement('button');
            resetBtn.type = 'button';
            resetBtn.className = 'playoff-btn ghost';
            resetBtn.textContent = 'Clear all rounds';
            resetBtn.disabled = readOnly;
            resetBtn.onclick = function () {
                if (!confirm('Clear all bracket rounds?')) return;
                p.rounds = [];
                p.currentRound = 1;
                save();
                render(league, mountEl, opts);
            };
            actionsRow.appendChild(resetBtn);
        }
        mountEl.appendChild(actionsRow);

        // ── ROUNDS ──
        if (p.rounds.length > 0) {
            p.rounds.forEach(function (rnd, idx) {
                renderRoundCard(rnd, idx, league, mountEl, sportsList, save, opts);
            });

            // Advance button
            var lastIdx = p.rounds.length - 1;
            var lastRound = p.rounds[lastIdx];
            var nonByeWinners = (lastRound.matchups || []).filter(function (m) {
                return m && m.winner && m.winner !== 'BYE';
            }).length;
            if (isRoundComplete(lastRound) && nonByeWinners >= 2) {
                var nextRow = document.createElement('div');
                nextRow.className = 'playoff-actions-row';
                var advBtn = document.createElement('button');
                advBtn.type = 'button';
                advBtn.className = 'playoff-btn primary';
                advBtn.textContent = 'Generate Round ' + (lastRound.number + 1);
                advBtn.disabled = readOnly;
                advBtn.onclick = function () {
                    var nextMatchups = (p.style === 'reseed')
                        ? advanceReseed(lastRound, p.seedOrder)
                        : advanceFixed(lastRound);
                    p.rounds.push({
                        number: lastRound.number + 1,
                        matchups: nextMatchups
                    });
                    p.currentRound = lastRound.number + 1;
                    save();
                    render(league, mountEl, opts);
                };
                nextRow.appendChild(advBtn);
                mountEl.appendChild(nextRow);
            } else if (lastRound.matchups && lastRound.matchups.length === 1
                       && lastRound.matchups[0].winner) {
                // Champion declared
                var champRow = document.createElement('div');
                champRow.className = 'playoff-champion';
                champRow.textContent = '🏆 Champion: ' + lastRound.matchups[0].winner;
                mountEl.appendChild(champRow);
            }
        }

        // ── RESERVED ACTIVITIES ──
        var reservedCard = document.createElement('div');
        reservedCard.className = 'playoff-card';
        var reservedHead = document.createElement('div');
        reservedHead.className = 'playoff-card-head';
        reservedHead.textContent = 'Reserve activities for non-playoff time';
        reservedCard.appendChild(reservedHead);

        var reservedSub = document.createElement('div');
        reservedSub.className = 'playoff-card-sub';
        reservedSub.textContent = 'When a playoff round runs, these activities/fields will be locked exclusively for this league’s divisions, so the auto-scheduler can route the not-playing kids into them.';
        reservedCard.appendChild(reservedSub);

        var reservedChips = document.createElement('div');
        reservedChips.className = 'playoff-chips';

        if (activitiesList.length === 0) {
            var none = document.createElement('div');
            none.className = 'playoff-card-sub';
            none.textContent = 'No facilities available — configure them in the Facilities tab first.';
            reservedCard.appendChild(none);
        } else {
            activitiesList.forEach(function (act) {
                var chip = document.createElement('span');
                var on = (p.reservedActivities || []).indexOf(act) >= 0;
                chip.className = 'playoff-chip' + (on ? ' active' : '');
                chip.textContent = act;
                if (!readOnly) {
                    chip.onclick = function () {
                        if (on) p.reservedActivities = p.reservedActivities.filter(function (a) { return a !== act; });
                        else p.reservedActivities.push(act);
                        save();
                        render(league, mountEl, opts);
                    };
                }
                reservedChips.appendChild(chip);
            });
            reservedCard.appendChild(reservedChips);
        }
        mountEl.appendChild(reservedCard);
    }

    function renderSeedList(card, league, save, opts) {
        var p = league.playoff;
        var teams = (league.teams || []).slice();
        var seedOrder = (p.seedOrder || []).slice();

        // Drop seeds that no longer correspond to a team
        seedOrder = seedOrder.filter(function (t) { return teams.indexOf(t) >= 0; });
        // Persist cleanup so generateRound1 won't include removed teams
        if (seedOrder.length !== p.seedOrder.length) {
            p.seedOrder = seedOrder.slice();
            save();
        }

        // Build list container
        var list = document.createElement('div');
        list.className = 'playoff-seed-list';
        seedOrder.forEach(function (team, idx) {
            var row = document.createElement('div');
            row.className = 'playoff-seed-row';
            row.draggable = !opts.readOnly;
            row.setAttribute('data-idx', idx);

            var rank = document.createElement('span');
            rank.className = 'playoff-seed-rank';
            rank.textContent = (idx + 1) + '.';
            row.appendChild(rank);

            var name = document.createElement('span');
            name.className = 'playoff-seed-name';
            name.textContent = team;
            row.appendChild(name);

            var btnWrap = document.createElement('span');
            btnWrap.className = 'playoff-seed-btns';

            var up = document.createElement('button');
            up.type = 'button';
            up.textContent = '▲';
            up.title = 'Move up';
            up.disabled = opts.readOnly || idx === 0;
            up.onclick = function () {
                if (idx === 0) return;
                var tmp = p.seedOrder[idx - 1];
                p.seedOrder[idx - 1] = p.seedOrder[idx];
                p.seedOrder[idx] = tmp;
                save();
                renderSeedList(card, league, save, opts);
            };
            btnWrap.appendChild(up);

            var down = document.createElement('button');
            down.type = 'button';
            down.textContent = '▼';
            down.title = 'Move down';
            down.disabled = opts.readOnly || idx === seedOrder.length - 1;
            down.onclick = function () {
                if (idx === p.seedOrder.length - 1) return;
                var tmp = p.seedOrder[idx + 1];
                p.seedOrder[idx + 1] = p.seedOrder[idx];
                p.seedOrder[idx] = tmp;
                save();
                renderSeedList(card, league, save, opts);
            };
            btnWrap.appendChild(down);

            var rm = document.createElement('button');
            rm.type = 'button';
            rm.textContent = '×';
            rm.title = 'Remove from seeds';
            rm.disabled = opts.readOnly;
            rm.onclick = function () {
                p.seedOrder = p.seedOrder.filter(function (t) { return t !== team; });
                save();
                renderSeedList(card, league, save, opts);
            };
            btnWrap.appendChild(rm);

            row.appendChild(btnWrap);

            // Drag-drop to reorder
            row.ondragstart = function (e) {
                e.dataTransfer.setData('text/plain', String(idx));
                e.dataTransfer.effectAllowed = 'move';
                row.classList.add('dragging');
            };
            row.ondragend = function () { row.classList.remove('dragging'); };
            row.ondragover = function (e) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                row.classList.add('drag-over');
            };
            row.ondragleave = function () { row.classList.remove('drag-over'); };
            row.ondrop = function (e) {
                e.preventDefault();
                row.classList.remove('drag-over');
                var fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
                var toIdx = parseInt(row.getAttribute('data-idx'), 10);
                if (isNaN(fromIdx) || isNaN(toIdx) || fromIdx === toIdx) return;
                var item = p.seedOrder.splice(fromIdx, 1)[0];
                p.seedOrder.splice(toIdx, 0, item);
                save();
                renderSeedList(card, league, save, opts);
            };

            list.appendChild(row);
        });

        // "Add team" picker for any team not yet seeded
        var addRow = document.createElement('div');
        addRow.className = 'playoff-seed-add';
        var unseeded = teams.filter(function (t) { return seedOrder.indexOf(t) < 0; });
        if (unseeded.length > 0) {
            var sel = document.createElement('select');
            sel.disabled = opts.readOnly;
            var ph = document.createElement('option');
            ph.value = '';
            ph.textContent = '-- add team to seeds --';
            sel.appendChild(ph);
            unseeded.forEach(function (t) {
                var o = document.createElement('option');
                o.value = t;
                o.textContent = t;
                sel.appendChild(o);
            });
            sel.onchange = function () {
                if (!sel.value) return;
                p.seedOrder.push(sel.value);
                save();
                renderSeedList(card, league, save, opts);
            };
            addRow.appendChild(sel);

            var allBtn = document.createElement('button');
            allBtn.type = 'button';
            allBtn.className = 'playoff-btn ghost';
            allBtn.textContent = 'Add all remaining';
            allBtn.disabled = opts.readOnly;
            allBtn.onclick = function () {
                unseeded.forEach(function (t) { p.seedOrder.push(t); });
                save();
                renderSeedList(card, league, save, opts);
            };
            addRow.appendChild(allBtn);
        }

        // Mount into card (replace any existing list)
        var prevList = card.querySelector('.playoff-seed-list');
        if (prevList) prevList.remove();
        var prevAdd = card.querySelector('.playoff-seed-add');
        if (prevAdd) prevAdd.remove();
        card.appendChild(list);
        card.appendChild(addRow);
    }

    function renderRoundCard(round, roundIdx, league, mountEl, sportsList, save, opts) {
        var card = document.createElement('div');
        card.className = 'playoff-round-card';

        var head = document.createElement('div');
        head.className = 'playoff-round-head';
        head.textContent = 'Round ' + round.number;
        var isSettled = roundIdx < (league.playoff.rounds || []).length - 1;
        if (isRoundComplete(round)) {
            var done = document.createElement('span');
            done.className = 'playoff-round-status';
            done.textContent = isSettled ? 'locked' : 'complete';
            head.appendChild(done);
        }
        card.appendChild(head);

        if (!round.matchups || round.matchups.length === 0) {
            var none = document.createElement('div');
            none.className = 'playoff-card-sub';
            none.textContent = 'No matchups in this round.';
            card.appendChild(none);
            mountEl.appendChild(card);
            return;
        }

        // Lock winner buttons on rounds that already have a successor
        var roundOpts = isSettled
            ? Object.assign({}, opts, { readOnly: true })
            : opts;

        var grid = document.createElement('div');
        grid.className = 'playoff-matchup-grid';

        round.matchups.forEach(function (m, mi) {
            grid.appendChild(renderMatchup(m, round, mi, sportsList, save, roundOpts));
        });

        card.appendChild(grid);
        mountEl.appendChild(card);
    }

    function renderMatchup(m, round, mi, sportsList, save, opts) {
        var box = document.createElement('div');
        box.className = 'playoff-matchup' + (m.winner ? ' decided' : '') + (m.isBye ? ' bye' : '');

        function renderTeam(side) {
            var name = m[side];
            var seed = m[side === 'teamA' ? 'seedA' : 'seedB'];
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'playoff-team' + (m.winner === name ? ' winner' : '')
                + (name === 'BYE' ? ' bye' : '');
            btn.disabled = opts.readOnly || name === 'BYE' || m.isBye;
            var seedStr = seed ? '#' + seed + ' ' : '';
            btn.innerHTML = '<span class="playoff-team-seed">' + escHtml(seedStr) + '</span>'
                          + '<span class="playoff-team-name">' + escHtml(name || '') + '</span>';
            btn.onclick = function () {
                m.winner = (m.winner === name) ? null : name;
                save();
                // Re-render the whole UI so the advance button etc. updates.
                var mount = box.closest('.playoff-mount');
                if (mount && mount._reRender) mount._reRender();
            };
            return btn;
        }

        box.appendChild(renderTeam('teamA'));

        var vs = document.createElement('span');
        vs.className = 'playoff-vs';
        vs.textContent = 'vs';
        box.appendChild(vs);

        box.appendChild(renderTeam('teamB'));

        // Sport dropdown
        var sportRow = document.createElement('div');
        sportRow.className = 'playoff-sport-row';

        var sportLabel = document.createElement('span');
        sportLabel.className = 'playoff-sport-label';
        sportLabel.textContent = 'Sport:';
        sportRow.appendChild(sportLabel);

        var sportSel = document.createElement('select');
        sportSel.disabled = opts.readOnly || m.isBye;
        var phOpt = document.createElement('option');
        phOpt.value = '';
        phOpt.textContent = '-- pick sport --';
        sportSel.appendChild(phOpt);
        (sportsList || []).forEach(function (s) {
            var o = document.createElement('option');
            o.value = s;
            o.textContent = s;
            if (m.sport === s) o.selected = true;
            sportSel.appendChild(o);
        });
        sportSel.onchange = function () {
            m.sport = sportSel.value;
            save();
        };
        sportRow.appendChild(sportSel);

        if (m.isBye) {
            var byeNote = document.createElement('span');
            byeNote.className = 'playoff-bye-note';
            byeNote.textContent = 'auto-advance';
            sportRow.appendChild(byeNote);
        }

        box.appendChild(sportRow);
        return box;
    }

    // -------------------------------------------------------------------------
    // Re-render hook for matchup-card click
    // -------------------------------------------------------------------------
    var _origRender = render;
    render = function (league, mountEl, opts) {
        _origRender(league, mountEl, opts);
        if (mountEl) mountEl._reRender = function () { _origRender(league, mountEl, opts); };
    };

    // -------------------------------------------------------------------------
    // CSS injection (one-shot)
    // -------------------------------------------------------------------------
    function injectStyles() {
        if (document.getElementById('playoff-mode-styles')) return;
        var st = document.createElement('style');
        st.id = 'playoff-mode-styles';
        st.textContent = [
            '.playoff-mount{display:flex;flex-direction:column;gap:12px;font-family:inherit;color:#1F2937;margin-top:12px;}',
            '.playoff-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border:1px solid #E5E7EB;border-radius:10px;background:#F9FAFB;}',
            '.playoff-title{font-size:0.95rem;font-weight:700;color:#111827;}',
            '.playoff-enable{display:flex;align-items:center;gap:6px;font-size:0.85rem;color:#374151;cursor:pointer;}',
            '.playoff-enable input{accent-color:#147D91;}',
            '.playoff-hint{padding:10px 14px;background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;color:#78350F;font-size:0.82rem;line-height:1.4;}',
            '.playoff-card{padding:12px 14px;border:1px solid #E5E7EB;border-radius:10px;background:#fff;display:flex;flex-direction:column;gap:8px;}',
            '.playoff-card-head{font-size:0.82rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#374151;}',
            '.playoff-card-sub{font-size:0.78rem;color:#6B7280;}',
            '.playoff-style-row{display:flex;gap:8px;flex-wrap:wrap;}',
            '.playoff-pill{flex:1;min-width:200px;padding:10px 14px;border:1px solid #E5E7EB;border-radius:10px;background:#fff;cursor:pointer;text-align:left;font-family:inherit;color:#374151;line-height:1.3;}',
            '.playoff-pill strong{display:block;color:#111827;font-size:0.9rem;}',
            '.playoff-pill span{font-size:0.75rem;color:#6B7280;}',
            '.playoff-pill:hover{border-color:#147D91;}',
            '.playoff-pill.active{border-color:#147D91;background:#ECFEFF;color:#0F766E;}',
            '.playoff-pill.active strong{color:#0F766E;}',
            '.playoff-pill:disabled{opacity:0.6;cursor:default;}',
            '.playoff-actions-row{display:flex;gap:8px;flex-wrap:wrap;}',
            '.playoff-btn{padding:8px 14px;border:1px solid #D1D5DB;background:#fff;border-radius:8px;cursor:pointer;font-size:0.85rem;font-weight:500;font-family:inherit;color:#374151;}',
            '.playoff-btn:hover:not(:disabled){border-color:#147D91;color:#147D91;}',
            '.playoff-btn.primary{background:#147D91;color:#fff;border-color:#147D91;}',
            '.playoff-btn.primary:hover:not(:disabled){background:#0F6E80;}',
            '.playoff-btn.ghost{background:transparent;}',
            '.playoff-btn:disabled{opacity:0.5;cursor:default;}',
            '.playoff-seed-list{display:flex;flex-direction:column;gap:4px;}',
            '.playoff-seed-row{display:flex;align-items:center;gap:10px;padding:6px 8px;background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;cursor:grab;}',
            '.playoff-seed-row.dragging{opacity:0.4;}',
            '.playoff-seed-row.drag-over{border-color:#147D91;background:#ECFEFF;}',
            '.playoff-seed-rank{font-weight:700;font-size:0.85rem;color:#6B7280;min-width:24px;}',
            '.playoff-seed-name{flex:1;font-size:0.88rem;color:#111827;}',
            '.playoff-seed-btns{display:flex;gap:4px;}',
            '.playoff-seed-btns button{width:24px;height:24px;border:1px solid #D1D5DB;background:#fff;border-radius:5px;cursor:pointer;font-size:0.7rem;color:#6B7280;}',
            '.playoff-seed-btns button:hover:not(:disabled){border-color:#147D91;color:#147D91;}',
            '.playoff-seed-btns button:disabled{opacity:0.4;cursor:default;}',
            '.playoff-seed-add{display:flex;gap:6px;align-items:center;margin-top:4px;}',
            '.playoff-seed-add select{padding:6px 8px;border:1px solid #D1D5DB;border-radius:6px;font-size:0.82rem;background:#fff;}',
            '.playoff-round-card{padding:12px 14px;border:1px solid #E5E7EB;border-radius:10px;background:#fff;display:flex;flex-direction:column;gap:10px;}',
            '.playoff-round-head{font-size:0.95rem;font-weight:700;color:#111827;display:flex;align-items:center;gap:8px;}',
            '.playoff-round-status{font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;background:#D1FAE5;color:#065F46;padding:2px 8px;border-radius:8px;}',
            '.playoff-matchup-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:8px;}',
            '.playoff-matchup{display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid #E5E7EB;border-radius:10px;background:#F9FAFB;}',
            '.playoff-matchup.bye{opacity:0.7;background:#F3F4F6;}',
            '.playoff-matchup.decided{border-color:#147D91;background:#ECFEFF;}',
            '.playoff-team{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid #D1D5DB;background:#fff;border-radius:8px;text-align:left;cursor:pointer;font-family:inherit;font-size:0.85rem;color:#374151;}',
            '.playoff-team:hover:not(:disabled){border-color:#147D91;}',
            '.playoff-team.winner{background:#147D91;color:#fff;border-color:#147D91;font-weight:600;}',
            '.playoff-team.bye{background:#F3F4F6;color:#9CA3AF;font-style:italic;}',
            '.playoff-team:disabled{cursor:default;}',
            '.playoff-team-seed{font-size:0.7rem;color:#6B7280;font-weight:600;min-width:28px;}',
            '.playoff-team.winner .playoff-team-seed{color:#A7F3D0;}',
            '.playoff-team-name{flex:1;}',
            '.playoff-vs{font-size:0.7rem;color:#6B7280;text-align:center;text-transform:uppercase;letter-spacing:.04em;}',
            '.playoff-sport-row{display:flex;align-items:center;gap:6px;font-size:0.78rem;}',
            '.playoff-sport-label{color:#6B7280;font-weight:600;}',
            '.playoff-sport-row select{flex:1;padding:5px 8px;border:1px solid #D1D5DB;border-radius:6px;font-size:0.82rem;background:#fff;font-family:inherit;}',
            '.playoff-bye-note{font-size:0.7rem;color:#9CA3AF;font-style:italic;}',
            '.playoff-chips{display:flex;flex-wrap:wrap;gap:6px;}',
            '.playoff-chip{display:inline-block;padding:4px 10px;background:#F3F4F6;border:1px solid #E5E7EB;border-radius:999px;font-size:0.78rem;color:#374151;cursor:pointer;}',
            '.playoff-chip:hover{border-color:#147D91;}',
            '.playoff-chip.active{background:#147D91;color:#fff;border-color:#147D91;}',
            '.playoff-champion{padding:14px;text-align:center;font-size:1rem;font-weight:700;color:#92400E;background:#FEF3C7;border:1px solid #FDE68A;border-radius:10px;}'
        ].join('');
        document.head.appendChild(st);
    }
    if (typeof document !== 'undefined') {
        if (document.head) injectStyles();
        else document.addEventListener('DOMContentLoaded', injectStyles);
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------
    window.PlayoffMode = {
        VERSION: VERSION,
        getOrInit: getOrInit,
        isLeagueInPlayoff: isLeagueInPlayoff,
        getActiveRound: getActiveRound,
        getActiveMatchups: getActiveMatchups,
        isRoundComplete: isRoundComplete,
        generateRound1: generateRound1,
        advanceFixed: advanceFixed,
        advanceReseed: advanceReseed,
        render: function (league, mountEl, opts) { render(league, mountEl, opts); }
    };

    if (typeof console !== 'undefined') console.log('[PlayoffMode] v' + VERSION + ' loaded');
})();
