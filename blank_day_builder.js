// =========================================================================
// blank_day_builder.js — "Build the Day (off-paper)"
//
// Loads one of the user's saved TEMPLATES as a BLANK version of the REAL
// schedule grid (same look/interactions as a generated day), and lets them
// hand-fill what each bunk actually did off-paper — per bunk, plus LEAGUE
// matchups + who won. NO legality checks, NO warnings: it just records the day.
//
// On "Save & Count":
//   • Regular activities → written to scheduleAssignments and run through the
//     same counting pipeline a generated day uses (saveSchedule +
//     RotationCloud.save + rebuildHistoricalCounts) → rotation fairness/recency.
//   • League games → LeaguesAPI.recordManualGameResult (matchup + winner) →
//     league standings, exactly like a played+scored game.
//
// Reuse-first: the grid IS window.renderTransposedView (via updateTable). This
// file only sets up the blank in-memory day, drives editing with its own
// warning-free pickers via a capture-phase click layer, and persists.
// Two tiny gated hooks live in unified_schedule_system.js (window.__blankDayMode:
// skip schedule reload + skip full-division merge while building).
//
// Killswitch: window.__blankDayBuilder = false.
// =========================================================================
(function () {
    'use strict';

    var BTN_ID = 'bdb-open-btn';
    var PICK_ID = 'bdb-tpl-overlay';
    var EDIT_ID = 'bdb-edit-overlay';
    var BANNER_ID = 'bdb-banner';

    // Build-session state
    var _mode = false;
    var _dateKey = null;
    var _dt = null;                 // divisionTimes we render against
    var _leagueSlotKeys = null;     // Set of "div|slotIdx" that are league slots
    var _leagueDraft = null;        // { "div|slotIdx": {leagueName, gameLabel, matches:[{teamA,teamB,sport,winner}]} }
    var _gridEl = null;
    var _clickHandler = null;

    function isEnabled() { return window.__blankDayBuilder !== false; }

    // ---- helpers -------------------------------------------------------
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function minToLabel(m) {
        if (m == null || isNaN(m)) return '';
        var h = Math.floor(m / 60), mm = m % 60, ap = h >= 12 ? 'pm' : 'am', h12 = h % 12 || 12;
        return h12 + ':' + (mm < 10 ? '0' + mm : mm) + ap;
    }
    function currentDate() {
        return window.currentScheduleDate || new Date().toISOString().split('T')[0];
    }
    function getTemplates() { return (window.getSavedSkeletons && window.getSavedSkeletons()) || {}; }
    function bunkName(b) { return typeof b === 'string' ? b : (b && (b.name || b.bunk || b.id) || ''); }

    function getActivities() {
        var gs = (window.loadGlobalSettings && window.loadGlobalSettings()) || {};
        var app1 = gs.app1 || {};
        var set = {};
        (app1.fields || []).forEach(function (f) { (f && f.activities || []).forEach(function (a) { if (a) set[a] = true; }); });
        var specials = (window.getAllSpecialActivities && window.getAllSpecialActivities()) || app1.specialActivities || [];
        specials.forEach(function (s) { if (s && s.name) set[s.name] = true; });
        return Object.keys(set).sort(function (a, b) { return a.localeCompare(b); });
    }

    function isLeagueSlot(slot) {
        if (!slot) return false;
        var t = String(slot.type || '').toLowerCase();
        if (t === 'league' || t === 'specialty_league') return true;
        // Fallback for templates that only label the tile by event text.
        return String(slot.event || '').toLowerCase().indexOf('league') >= 0;
    }

    function dateHasRealSchedule() {
        var sa = window.scheduleAssignments || {};
        for (var b in sa) {
            var arr = sa[b];
            if (!arr || typeof arr !== 'object') continue;
            for (var i in arr) {
                var e = arr[i];
                if (e && !e.continuation && e._activity && String(e._activity).toLowerCase() !== 'free') return true;
            }
        }
        return (window.leagueAssignments && Object.keys(window.leagueAssignments).length > 0) || false;
    }

    // ---- modal shell (shared) ------------------------------------------
    function overlayShell(id, innerHtml, maxW) {
        var ov = document.getElementById(id);
        if (ov) ov.remove();
        ov = document.createElement('div');
        ov.id = id;
        ov.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.55);z-index:100010;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:20px;';
        ov.innerHTML = '<div role="dialog" aria-modal="true" style="background:#fff;border-radius:14px;max-width:' + (maxW || 460) + 'px;width:100%;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,0.32);overflow:hidden;">' + innerHtml + '</div>';
        document.body.appendChild(ov);
        ov.addEventListener('mousedown', function (ev) { if (ev.target === ov) ov.remove(); });
        return ov;
    }
    function toast(msg) {
        try {
            var t = document.createElement('div');
            t.textContent = msg;
            t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#0f766e;color:#fff;padding:12px 20px;border-radius:10px;font-weight:600;font-size:0.9rem;box-shadow:0 10px 30px rgba(0,0,0,0.25);z-index:100060;font-family:-apple-system,sans-serif;';
            document.body.appendChild(t);
            setTimeout(function () { try { t.remove(); } catch (e) {} }, 3200);
        } catch (e) {}
    }

    // ---- step 1: pick a template ---------------------------------------
    function openTemplatePicker() {
        if (_mode) { exitBuildMode(true); }
        var dateKey = currentDate();
        var templates = getTemplates();
        var names = Object.keys(templates);

        var head = '<div style="padding:18px 22px 8px;border-bottom:1px solid #eef2f7;">'
            + '<div style="font-size:1.12rem;font-weight:800;color:#0f172a;">🗓 Build the Day <span style="font-weight:600;color:#64748b;font-size:0.85rem;">(off-paper)</span></div>'
            + '<div style="color:#64748b;font-size:0.85rem;margin-top:4px;">Pull in a template as a blank grid for <strong>' + esc(dateKey) + '</strong>, then fill in what each bunk actually did. No rules are applied.</div></div>';

        var body, foot;
        if (!names.length) {
            body = '<div style="padding:24px;color:#b91c1c;text-align:center;">You have no saved templates yet. Build and save one in the schedule builder first.</div>';
            foot = '<div style="padding:14px 22px;border-top:1px solid #eef2f7;display:flex;justify-content:flex-end;"><button id="bdb-p-cancel" style="padding:9px 18px;border:1px solid #d1d5db;border-radius:8px;background:#fff;font-weight:600;cursor:pointer;">Close</button></div>';
        } else {
            body = '<div style="padding:20px 22px;">'
                + '<label style="font-weight:700;color:#334155;font-size:0.88rem;display:block;margin-bottom:8px;">Template</label>'
                + '<select id="bdb-tpl" style="width:100%;padding:9px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:0.92rem;">'
                + '<option value="">Choose a template…</option>'
                + names.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join('')
                + '</select></div>';
            foot = '<div style="padding:14px 22px;border-top:1px solid #eef2f7;display:flex;justify-content:flex-end;gap:10px;">'
                + '<button id="bdb-p-cancel" style="padding:9px 18px;border:1px solid #d1d5db;border-radius:8px;background:#fff;font-weight:600;cursor:pointer;">Cancel</button>'
                + '<button id="bdb-p-start" style="padding:9px 20px;border:none;border-radius:8px;background:#0f766e;color:#fff;font-weight:700;cursor:pointer;opacity:0.5;pointer-events:none;">Start building</button></div>';
        }

        var ov = overlayShell(PICK_ID, head + body + foot, 480);
        ov.querySelector('#bdb-p-cancel').onclick = function () { ov.remove(); };
        var sel = ov.querySelector('#bdb-tpl');
        var start = ov.querySelector('#bdb-p-start');
        if (sel && start) {
            sel.onchange = function () {
                var on = !!this.value;
                start.style.opacity = on ? '1' : '0.5';
                start.style.pointerEvents = on ? 'auto' : 'none';
            };
            start.onclick = function () {
                var name = sel.value;
                if (!name) return;
                ov.remove();
                if (dateHasRealSchedule()) {
                    if (!window.confirm('This date (' + dateKey + ') already has a schedule.\n\nBuilding off-paper will REPLACE it with what you enter. Continue?')) return;
                }
                enterBuildMode(name);
            };
        }
    }

    // ---- step 2: enter build mode + render the real grid, blank --------
    function enterBuildMode(templateName) {
        var dateKey = currentDate();
        var skeleton = getTemplates()[templateName];
        if (!skeleton || !skeleton.length) { alert('That template is empty.'); return; }

        var dt = {};
        try {
            if (window.DivisionTimesSystem && window.DivisionTimesSystem.buildFromSkeleton) {
                dt = window.DivisionTimesSystem.buildFromSkeleton(skeleton, window.divisions || {}) || {};
            }
        } catch (e) { console.warn('[BlankDayBuilder] buildFromSkeleton failed:', e); }

        var divs = Object.keys(dt);
        if (!divs.length) { alert('This template has no period structure for your current divisions.'); return; }

        // Blank scheduleAssignments + league-slot index
        var assignments = {};
        var leagueKeys = {};
        divs.forEach(function (div) {
            var periods = dt[div] || [];
            periods.forEach(function (slot, si) { if (isLeagueSlot(slot)) leagueKeys[div + '|' + si] = true; });
            var bunksRaw = (window.divisions && window.divisions[div] && window.divisions[div].bunks) || [];
            bunksRaw.map(bunkName).filter(Boolean).forEach(function (bk) {
                assignments[bk] = new Array(periods.length).fill(null);
            });
        });

        _mode = true;
        _dateKey = dateKey;
        _dt = dt;
        _leagueSlotKeys = leagueKeys;
        _leagueDraft = {};

        window.__blankDayMode = true;
        window.currentScheduleDate = dateKey;
        window._scheduleAssignmentsDate = dateKey;
        window.scheduleAssignments = assignments;
        window.leagueAssignments = {};
        window.divisionTimes = dt;

        try { if (typeof window.showTab === 'function') window.showTab('schedule'); } catch (e) {}
        showBanner();
        rerenderGrid();
        attachClickLayer();
    }

    function exitBuildMode(silent) {
        _mode = false;
        window.__blankDayMode = false;
        detachClickLayer();
        var b = document.getElementById(BANNER_ID); if (b) b.remove();
        _dt = null; _leagueSlotKeys = null; _leagueDraft = null; _dateKey = null;
        // Restore the real saved day (render now reloads from cloud since mode is off).
        try { window.updateTable && window.updateTable(); } catch (e) {}
    }

    function rerenderGrid() {
        try { window.updateTable && window.updateTable(); } catch (e) { console.warn('[BlankDayBuilder] render failed:', e); }
    }

    // ---- banner --------------------------------------------------------
    function showBanner() {
        var host = document.getElementById('scheduleTable');
        if (!host || !host.parentNode) return;
        var old = document.getElementById(BANNER_ID); if (old) old.remove();
        var bar = document.createElement('div');
        bar.id = BANNER_ID;
        bar.style.cssText = 'position:sticky;top:0;z-index:40;display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:linear-gradient(90deg,#0f766e,#0d9488);color:#fff;padding:12px 16px;border-radius:10px;margin-bottom:12px;box-shadow:0 6px 20px rgba(15,118,110,0.3);font-family:-apple-system,sans-serif;';
        bar.innerHTML =
            '<span style="font-weight:800;">🗓 Building ' + esc(_dateKey) + ' (off-paper)</span>'
            + '<span style="font-size:0.85rem;opacity:0.9;">Click any cell to fill in what was done — activities per bunk, or a league matchup. No rules applied.</span>'
            + '<span style="flex:1;"></span>'
            + '<button id="bdb-cancel" style="padding:8px 16px;border:1px solid rgba(255,255,255,0.6);border-radius:8px;background:transparent;color:#fff;font-weight:600;cursor:pointer;">Cancel</button>'
            + '<button id="bdb-save" style="padding:8px 18px;border:none;border-radius:8px;background:#fff;color:#0f766e;font-weight:800;cursor:pointer;">Save &amp; Count</button>';
        host.parentNode.insertBefore(bar, host);
        bar.querySelector('#bdb-cancel').onclick = function () {
            if (window.confirm('Discard this off-paper day? Nothing will be saved.')) exitBuildMode();
        };
        bar.querySelector('#bdb-save').onclick = saveAndCount;
    }

    // ---- capture-phase click layer over the REAL grid ------------------
    function attachClickLayer() {
        detachClickLayer();
        _gridEl = document.getElementById('scheduleTable');
        if (!_gridEl) return;
        _clickHandler = function (e) {
            var td = e.target && e.target.closest && e.target.closest('td[data-bunk]');
            if (!td || !_gridEl.contains(td)) return;
            e.stopPropagation();
            e.preventDefault();
            var bunk = td.dataset.bunk;
            var div = td.dataset.division;
            var slotIdx = parseInt(td.dataset.slotIndex != null ? td.dataset.slotIndex : td.dataset.slot, 10);
            if (isNaN(slotIdx)) return;
            if (_leagueSlotKeys && _leagueSlotKeys[div + '|' + slotIdx]) openLeagueEditor(div, slotIdx);
            else openActivityPicker(div, bunk, slotIdx);
        };
        _gridEl.addEventListener('click', _clickHandler, true); // capture → beats the cell's own onclick
    }
    function detachClickLayer() {
        if (_gridEl && _clickHandler) { try { _gridEl.removeEventListener('click', _clickHandler, true); } catch (e) {} }
        _gridEl = null; _clickHandler = null;
    }

    // ---- activity picker (per bunk, no warnings) -----------------------
    function openActivityPicker(div, bunk, slotIdx) {
        var period = (_dt[div] || [])[slotIdx] || {};
        var cur = (window.scheduleAssignments[bunk] || [])[slotIdx];
        var curAct = (cur && cur._activity) || '';
        var activities = getActivities();
        var head = '<div style="padding:16px 20px 10px;border-bottom:1px solid #eef2f7;">'
            + '<div style="font-weight:800;color:#0f172a;font-size:1rem;">' + esc(bunk) + '</div>'
            + '<div style="color:#64748b;font-size:0.82rem;margin-top:2px;">' + esc(div) + ' · ' + minToLabel(period.startMin) + '–' + minToLabel(period.endMin) + (period.event ? ' · ' + esc(period.event) : '') + '</div></div>';
        var body = '<div style="padding:18px 20px;">'
            + '<label style="font-weight:700;color:#334155;font-size:0.85rem;display:block;margin-bottom:8px;">What did they do?</label>'
            + '<select id="bdb-act" style="width:100%;padding:9px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:0.92rem;">'
            + '<option value="">— (leave blank / clear) —</option>'
            + activities.map(function (a) { return '<option value="' + esc(a) + '"' + (a === curAct ? ' selected' : '') + '>' + esc(a) + '</option>'; }).join('')
            + '</select></div>';
        var foot = '<div style="padding:12px 20px;border-top:1px solid #eef2f7;display:flex;justify-content:flex-end;gap:10px;">'
            + '<button id="bdb-a-cancel" style="padding:8px 16px;border:1px solid #d1d5db;border-radius:8px;background:#fff;font-weight:600;cursor:pointer;">Cancel</button>'
            + '<button id="bdb-a-ok" style="padding:8px 18px;border:none;border-radius:8px;background:#0f766e;color:#fff;font-weight:700;cursor:pointer;">Set</button></div>';
        var ov = overlayShell(EDIT_ID, head + body + foot, 420);
        ov.querySelector('#bdb-a-cancel').onclick = function () { ov.remove(); };
        ov.querySelector('#bdb-a-ok').onclick = function () {
            var act = ov.querySelector('#bdb-act').value;
            if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = [];
            if (!act) {
                window.scheduleAssignments[bunk][slotIdx] = null;
            } else {
                window.scheduleAssignments[bunk][slotIdx] = {
                    field: act, sport: act, continuation: false, _fixed: true,
                    _activity: act, _displayName: null, _location: null, _offPaper: true,
                    _postEdit: true, _pinned: false,
                    _startMin: period.startMin, _endMin: period.endMin, _editedAt: Date.now()
                };
            }
            ov.remove();
            rerenderGrid();
        };
    }

    // ---- league matchup editor (matchup + winner) ----------------------
    function openLeagueEditor(div, slotIdx) {
        var period = (_dt[div] || [])[slotIdx] || {};
        var key = div + '|' + slotIdx;
        var leagues = (window.LeaguesAPI && window.LeaguesAPI.getLeaguesForDivision) ? window.LeaguesAPI.getLeaguesForDivision(div) : [];
        var head = '<div style="padding:16px 20px 10px;border-bottom:1px solid #eef2f7;">'
            + '<div style="font-weight:800;color:#0f172a;font-size:1rem;">🏆 League game — ' + esc(div) + '</div>'
            + '<div style="color:#64748b;font-size:0.82rem;margin-top:2px;">' + minToLabel(period.startMin) + '–' + minToLabel(period.endMin) + (period.event ? ' · ' + esc(period.event) : '') + '</div></div>';

        if (!leagues.length) {
            var b = overlayShell(EDIT_ID, head + '<div style="padding:22px;color:#b91c1c;text-align:center;">No leagues are configured for this division.</div>'
                + '<div style="padding:12px 20px;border-top:1px solid #eef2f7;display:flex;justify-content:flex-end;"><button id="bdb-l-close" style="padding:8px 16px;border:1px solid #d1d5db;border-radius:8px;background:#fff;font-weight:600;cursor:pointer;">Close</button></div>', 520);
            b.querySelector('#bdb-l-close').onclick = function () { b.remove(); };
            return;
        }

        var draft = _leagueDraft[key] || { leagueName: leagues[0].name, gameLabel: 'Off-Paper ' + minToLabel(period.startMin), matches: [] };
        var body = '<div style="padding:16px 20px;overflow:auto;">'
            + '<label style="font-weight:700;color:#334155;font-size:0.85rem;display:block;margin-bottom:6px;">League</label>'
            + '<select id="bdb-l-league" style="width:100%;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:0.9rem;margin-bottom:14px;">'
            + leagues.map(function (l) { return '<option value="' + esc(l.name) + '"' + (l.name === draft.leagueName ? ' selected' : '') + '>' + esc(l.name) + '</option>'; }).join('')
            + '</select>'
            + '<div style="display:flex;align-items:center;margin-bottom:6px;"><span style="font-weight:700;color:#334155;font-size:0.85rem;">Matchups played</span><span style="flex:1;"></span><button id="bdb-l-add" style="padding:5px 12px;border:1px solid #0f766e;border-radius:7px;background:#f0fdfa;color:#0f766e;font-weight:700;font-size:0.82rem;cursor:pointer;">+ Add matchup</button></div>'
            + '<div id="bdb-l-rows"></div></div>';
        var foot = '<div style="padding:12px 20px;border-top:1px solid #eef2f7;display:flex;justify-content:flex-end;gap:10px;">'
            + '<button id="bdb-l-cancel" style="padding:8px 16px;border:1px solid #d1d5db;border-radius:8px;background:#fff;font-weight:600;cursor:pointer;">Cancel</button>'
            + '<button id="bdb-l-ok" style="padding:8px 18px;border:none;border-radius:8px;background:#0f766e;color:#fff;font-weight:700;cursor:pointer;">Save game</button></div>';

        var ov = overlayShell(EDIT_ID, head + body + foot, 640);
        var leagueSel = ov.querySelector('#bdb-l-league');
        var rowsHost = ov.querySelector('#bdb-l-rows');

        function leagueByName(n) { for (var i = 0; i < leagues.length; i++) if (leagues[i].name === n) return leagues[i]; return leagues[0]; }
        function rowHtml(m) {
            var lg = leagueByName(leagueSel.value);
            var teamOpts = function (sel) { return '<option value="">Team…</option>' + (lg.teams || []).map(function (t) { return '<option' + (t === sel ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join(''); };
            var sportOpts = '<option value="">Sport…</option>' + (lg.sports || []).map(function (s) { return '<option' + (s === (m.sport || '') ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('');
            function winOpt(v, lbl) { return '<option value="' + v + '"' + ((m.winner || '') === v ? ' selected' : '') + '>' + lbl + '</option>'; }
            return '<div class="bdb-l-row" style="display:flex;gap:6px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">'
                + '<select class="bdb-l-a" style="flex:1;min-width:90px;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:0.82rem;">' + teamOpts(m.teamA || '') + '</select>'
                + '<span style="color:#94a3b8;font-size:0.8rem;">vs</span>'
                + '<select class="bdb-l-b" style="flex:1;min-width:90px;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:0.82rem;">' + teamOpts(m.teamB || '') + '</select>'
                + '<select class="bdb-l-sport" style="min-width:90px;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:0.82rem;">' + sportOpts + '</select>'
                + '<select class="bdb-l-win" title="Who won" style="min-width:96px;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:0.82rem;">'
                + winOpt('', 'Result…') + winOpt('A', 'Team A won') + winOpt('B', 'Team B won') + winOpt('T', 'Tie') + '</select>'
                + '<button class="bdb-l-del" title="Remove" style="border:none;background:transparent;color:#ef4444;font-size:1.1rem;cursor:pointer;padding:0 4px;">×</button>'
                + '</div>';
        }
        function collect() {
            var out = [];
            rowsHost.querySelectorAll('.bdb-l-row').forEach(function (r) {
                out.push({
                    teamA: r.querySelector('.bdb-l-a').value,
                    teamB: r.querySelector('.bdb-l-b').value,
                    sport: r.querySelector('.bdb-l-sport').value,
                    winner: r.querySelector('.bdb-l-win').value
                });
            });
            return out;
        }
        function paint(matches) {
            rowsHost.innerHTML = matches.length ? matches.map(rowHtml).join('') : '<div style="color:#94a3b8;font-size:0.82rem;padding:6px 0;">No matchups yet — click “Add matchup”.</div>';
            rowsHost.querySelectorAll('.bdb-l-del').forEach(function (btn) {
                btn.onclick = function () { var cur = collect(); var idx = Array.prototype.indexOf.call(rowsHost.querySelectorAll('.bdb-l-del'), btn); cur.splice(idx, 1); paint(cur); };
            });
        }
        paint(draft.matches && draft.matches.length ? draft.matches : []);
        ov.querySelector('#bdb-l-add').onclick = function () { var cur = collect(); cur.push({ teamA: '', teamB: '', sport: '', winner: '' }); paint(cur); };
        leagueSel.onchange = function () { paint(collect()); }; // repopulate team/sport options for the new league
        ov.querySelector('#bdb-l-cancel').onclick = function () { ov.remove(); };
        ov.querySelector('#bdb-l-ok').onclick = function () {
            var matches = collect().filter(function (m) { return m.teamA && m.teamB; });
            var leagueName = leagueSel.value;
            if (!matches.length) {
                // Clearing the slot's game
                delete _leagueDraft[key];
                if (window.leagueAssignments[div]) delete window.leagueAssignments[div][slotIdx];
            } else {
                _leagueDraft[key] = { leagueName: leagueName, gameLabel: draft.gameLabel, matches: matches };
                if (!window.leagueAssignments[div]) window.leagueAssignments[div] = {};
                window.leagueAssignments[div][slotIdx] = {
                    leagueName: leagueName,
                    gameLabel: draft.gameLabel,
                    sport: matches[0].sport || '',
                    matchups: matches.map(function (m) { return { teamA: m.teamA, teamB: m.teamB, display: m.teamA + ' vs ' + m.teamB + (m.sport ? ' (' + m.sport + ')' : '') }; }),
                    _startMin: period.startMin, _endMin: period.endMin
                };
            }
            ov.remove();
            rerenderGrid();
        };
    }

    // ---- save & count --------------------------------------------------
    function saveAndCount() {
        var dateKey = _dateKey || currentDate();

        // Count filled activities?
        var filled = 0;
        var sa = window.scheduleAssignments || {};
        Object.keys(sa).forEach(function (b) { (sa[b] || []).forEach(function (e) { if (e && e._activity && String(e._activity).toLowerCase() !== 'free') filled++; }); });
        var leagueGames = _leagueDraft ? Object.keys(_leagueDraft).length : 0;

        if (!filled && !leagueGames) {
            if (!window.confirm('Nothing has been filled in. Save an empty day anyway?')) return;
        }

        // 1) Persist the schedule + rotation counts (activities), mirroring a gen.
        try {
            var hist = (window.loadRotationHistory && window.loadRotationHistory()) || { bunks: {}, leagues: {} };
            hist.bunks = hist.bunks || {};
            var ts = Date.now();
            Object.keys(sa).forEach(function (b) {
                (sa[b] || []).forEach(function (e) {
                    if (!e || e.continuation || !e._activity) return;
                    if (String(e._activity).toLowerCase() === 'free') return;
                    hist.bunks[b] = hist.bunks[b] || {}; hist.bunks[b][e._activity] = ts;
                });
            });
            window.saveRotationHistory && window.saveRotationHistory(hist);
        } catch (e) { console.warn('[BlankDayBuilder] rotation history stamp failed:', e); }

        // Exit build mode BEFORE saveSchedule so saveSchedule persists in normal state,
        // but keep our in-memory day: capture references, turn mode off, then save.
        window.__blankDayMode = false;
        detachClickLayer();
        var banner = document.getElementById(BANNER_ID); if (banner) banner.remove();

        try { window.saveSchedule && window.saveSchedule(); } catch (e) { console.error('[BlankDayBuilder] saveSchedule failed:', e); }
        setTimeout(function () {
            try { window.SchedulerCoreUtils && window.SchedulerCoreUtils.rebuildHistoricalCounts && window.SchedulerCoreUtils.rebuildHistoricalCounts(true); } catch (e) {}
            try { window.RotationCloud && window.RotationCloud.save && window.RotationCloud.save(dateKey, window.scheduleAssignments || {}); } catch (e) {}
        }, 0);

        // 2) Record league games → standings (matchup + winner).
        var leaguesRecorded = 0;
        if (_leagueDraft) {
            Object.keys(_leagueDraft).forEach(function (k) {
                var d = _leagueDraft[k];
                if (!d || !d.matches || !d.matches.length) return;
                var matches = d.matches.map(function (m) {
                    var scoreA = null, scoreB = null;
                    if (m.winner === 'A') { scoreA = 1; scoreB = 0; }
                    else if (m.winner === 'B') { scoreA = 0; scoreB = 1; }
                    else if (m.winner === 'T') { scoreA = 1; scoreB = 1; }
                    return { teamA: m.teamA, teamB: m.teamB, sport: m.sport || null, scoreA: scoreA, scoreB: scoreB };
                });
                if (window.LeaguesAPI && window.LeaguesAPI.recordManualGameResult) {
                    if (window.LeaguesAPI.recordManualGameResult(d.leagueName, dateKey, d.gameLabel, matches)) leaguesRecorded++;
                }
            });
        }

        // Clear session state (grid keeps showing the saved day via updateTable).
        _mode = false; _dt = null; _leagueSlotKeys = null; _leagueDraft = null; _dateKey = null;
        try { window.updateTable && window.updateTable(); } catch (e) {}

        var msg = 'Saved ' + dateKey + ' — ' + filled + ' activit' + (filled === 1 ? 'y' : 'ies') + ' counted';
        if (leaguesRecorded) msg += ', ' + leaguesRecorded + ' league game' + (leaguesRecorded === 1 ? '' : 's') + ' recorded';
        toast(msg + '.');
        console.log('[BlankDayBuilder] Saved off-paper day', dateKey, '—', filled, 'activities,', leaguesRecorded, 'league games.');
    }

    // ---- button injection (survives DA toolbar re-renders) -------------
    function injectButton() {
        if (!isEnabled()) return;
        var gen = document.getElementById('da-generate-btn');
        if (!gen || document.getElementById(BTN_ID)) return;
        var b = document.createElement('button');
        b.id = BTN_ID;
        b.className = (gen.className || 'da-btn').replace('da-btn-success', 'da-btn-ghost');
        b.textContent = '🗓 Build Day';
        b.title = 'Fill in a blank template of what each bunk actually did off-paper (activities + league matchups) — counts into rotation & standings';
        b.onclick = openTemplatePicker;
        gen.parentNode.insertBefore(b, gen);
    }
    function startObserver() {
        if (!isEnabled()) return;
        injectButton();
        var host = document.getElementById('daily-adjustments-content') || document.body;
        var scheduled = false;
        var obs = new MutationObserver(function () {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(function () { scheduled = false; injectButton(); });
        });
        try { obs.observe(host, { childList: true, subtree: true }); } catch (e) {}
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startObserver);
    else startObserver();

    window.BlankDayBuilder = { open: openTemplatePicker };
    console.log('[BlankDayBuilder] v2 ready (real-grid + leagues)');
})();
