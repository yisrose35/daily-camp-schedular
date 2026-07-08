// =========================================================================
// offpaper_recorder.js — "Build the Day (off-paper)"  v3
//
// Records a day that was run OFF the system (on paper) so its numbers land in
// the system: rotation counts, league standings, and the league game counter.
//
// Design (modeled on Bunk Overrides, non-destructive):
//   • Own DATE field, confirmed in the tool — NOT tied to the main date picker.
//   • HARD guard: refuses to record onto a date that already has a schedule, so
//     it can never overwrite/erase a real day (the v2 failure mode).
//   • Per-bunk grid like Bunk Overrides: pick a grade → rows = the template's
//     periods, columns = bunks → click a cell to set what that bunk did. League
//     periods take a matchup + winner.
//   • Record → saves a viewable schedule for that (empty) date + updates rotation
//     counts + league standings + advances the league game counter (5 → 6).
//
// Self-contained. One <script> include; two additive LeaguesAPI helpers in
// leagues.js. No scheduler/solver code touched.
// Killswitch: window.__offpaperRecorder = false.
// =========================================================================
(function () {
    'use strict';

    var BTN_ID = 'opr-open-btn';
    var OV_ID = 'opr-overlay';
    var SUB_ID = 'opr-suboverlay';

    // session state
    var _dateKey = null, _template = null, _dt = null, _selectedDiv = null;
    var _acts = null;        // { "div|bunk|slot": activity }
    var _leagues = null;     // { "div|slot": { leagueName, matches:[{teamA,teamB,sport,winner}] } }
    var _leagueSlots = null; // Set-like { "div|slot": true }

    function isEnabled() { return window.__offpaperRecorder !== false; }

    // ---- helpers -------------------------------------------------------
    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function minLabel(m) {
        if (m == null || isNaN(m)) return '';
        var h = Math.floor(m / 60), mm = m % 60, ap = h >= 12 ? 'pm' : 'am', h12 = h % 12 || 12;
        return h12 + ':' + (mm < 10 ? '0' + mm : mm) + ap;
    }
    // Parse a typed time label ("10:50am", "1:30 pm", "13:30", "9am") → minutes-of-day, or null.
    function parseLabel(s) {
        if (s == null) return null;
        s = String(s).trim().toLowerCase().replace(/\s+/g, '');
        var m = s.match(/^(\d{1,2}):(\d{2})(am|pm)?$/) || (function () {
            var m2 = s.match(/^(\d{1,2})(am|pm)$/); return m2 ? [null, m2[1], '00', m2[2]] : null;
        })();
        if (!m) return null;
        var h = parseInt(m[1], 10), mm = parseInt(m[2], 10), ap = m[3];
        if (isNaN(h) || isNaN(mm) || h > 23 || mm > 59) return null;
        if (ap === 'pm' && h < 12) h += 12;
        if (ap === 'am' && h === 12) h = 0;
        return h * 60 + mm;
    }
    function todayKey() { return window.currentScheduleDate || new Date().toISOString().split('T')[0]; }
    function templates() { return (window.getSavedSkeletons && window.getSavedSkeletons()) || {}; }
    function divColor(div) { var d = (window.divisions || {})[div]; return (d && d.color) || '#0f766e'; }
    function bunkName(b) { return typeof b === 'string' ? b : (b && (b.name || b.bunk || b.id) || ''); }
    function bunksOf(div) {
        var d = (window.divisions || {})[div];
        return ((d && d.bunks) || []).map(bunkName).filter(Boolean);
    }
    function activities() {
        var gs = (window.loadGlobalSettings && window.loadGlobalSettings()) || {}, a1 = gs.app1 || {}, set = {};
        (a1.fields || []).forEach(function (f) { (f && f.activities || []).forEach(function (a) { if (a) set[a] = true; }); });
        var sp = (window.getAllSpecialActivities && window.getAllSpecialActivities()) || a1.specialActivities || [];
        sp.forEach(function (s) { if (s && s.name) set[s.name] = true; });
        return Object.keys(set).sort(function (a, b) { return a.localeCompare(b); });
    }
    function isLeagueSlot(slot) {
        if (!slot) return false;
        var t = String(slot.type || '').toLowerCase();
        if (t === 'league' || t === 'specialty_league') return true;
        return String(slot.event || '').toLowerCase().indexOf('league') >= 0;
    }

    // Does the target date already hold a real schedule (local OR cloud)?
    function dateHasSchedule(dateKey) {
        try {
            var all = (window.loadAllDailyData && window.loadAllDailyData()) || {};
            var sa = all[dateKey] && all[dateKey].scheduleAssignments;
            if (sa && _anyEntry(sa)) return Promise.resolve(true);
        } catch (e) {}
        if (window.ScheduleDB && window.ScheduleDB.loadSchedule) {
            return Promise.resolve(window.ScheduleDB.loadSchedule(dateKey)).then(function (r) {
                var sa = r && r.data && r.data.scheduleAssignments;
                return !!(sa && _anyEntry(sa));
            }).catch(function () { return false; });
        }
        return Promise.resolve(false);
    }
    function _anyEntry(sa) {
        for (var b in sa) {
            var arr = sa[b];
            if (!arr) continue;
            for (var i in arr) { var e = arr[i]; if (e && !e.continuation && e._activity && String(e._activity).toLowerCase() !== 'free') return true; }
        }
        return false;
    }

    function toast(msg, bad) {
        try {
            var t = document.createElement('div');
            t.textContent = msg;
            t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:' + (bad ? '#b91c1c' : '#0f766e') + ';color:#fff;padding:12px 20px;border-radius:10px;font-weight:600;font-size:0.9rem;box-shadow:0 10px 30px rgba(0,0,0,0.25);z-index:100090;font-family:-apple-system,sans-serif;';
            document.body.appendChild(t);
            setTimeout(function () { try { t.remove(); } catch (e) {} }, 3600);
        } catch (e) {}
    }
    function subOverlay(inner, maxW) {
        var o = document.getElementById(SUB_ID); if (o) o.remove();
        o = document.createElement('div'); o.id = SUB_ID;
        o.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.45);z-index:100085;display:flex;align-items:center;justify-content:center;padding:20px;font-family:-apple-system,sans-serif;';
        o.innerHTML = '<div role="dialog" style="background:#fff;border-radius:14px;max-width:' + (maxW || 460) + 'px;width:100%;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,0.32);overflow:hidden;">' + inner + '</div>';
        document.body.appendChild(o);
        o.addEventListener('mousedown', function (e) { if (e.target === o) o.remove(); });
        return o;
    }

    // =====================================================================
    // MAIN PANEL
    // =====================================================================
    function open() {
        if (document.getElementById(OV_ID)) return;
        _dateKey = null; _template = null; _dt = null; _selectedDiv = null;
        _acts = {}; _leagues = {}; _leagueSlots = {};

        var names = Object.keys(templates());
        var ov = document.createElement('div');
        ov.id = OV_ID;
        ov.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.55);z-index:100080;display:flex;align-items:center;justify-content:center;padding:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';
        ov.innerHTML =
            '<div role="dialog" aria-modal="true" style="background:#fff;border-radius:16px;max-width:1120px;width:100%;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,0.32);overflow:hidden;">'
            + '<div style="padding:16px 22px 12px;border-bottom:1px solid #eef2f7;">'
            + '<div style="display:flex;align-items:center;gap:10px;">'
            + '<div style="font-size:1.14rem;font-weight:800;color:#0f172a;">🗓 Build the Day <span style="font-weight:600;color:#64748b;font-size:0.85rem;">(off-paper)</span></div>'
            + '<div style="flex:1;"></div><button id="opr-x" style="border:none;background:transparent;font-size:1.5rem;line-height:1;color:#94a3b8;cursor:pointer;">&times;</button></div>'
            + '<div style="color:#64748b;font-size:0.84rem;margin-top:3px;">Record a day that was run off the system. Nothing here touches your existing schedules — it refuses any date that already has one.</div>'
            + (names.length
                ? '<div style="margin-top:12px;display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end;">'
                    + '<div><label style="display:block;font-size:0.78rem;font-weight:700;color:#334155;margin-bottom:4px;">Date</label>'
                    + '<input type="date" id="opr-date" value="' + esc(todayKey()) + '" style="padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;font-size:0.9rem;"></div>'
                    + '<div><label style="display:block;font-size:0.78rem;font-weight:700;color:#334155;margin-bottom:4px;">Template</label>'
                    + '<select id="opr-tpl" style="padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:0.9rem;min-width:200px;"><option value="">Choose…</option>'
                    + names.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join('') + '</select></div>'
                    + '<button id="opr-load" style="padding:9px 18px;border:none;border-radius:8px;background:#0f766e;color:#fff;font-weight:700;cursor:pointer;opacity:0.5;pointer-events:none;">Load grid</button>'
                    + '<div id="opr-guard" style="font-size:0.82rem;color:#b91c1c;font-weight:600;"></div>'
                    + '</div>'
                : '<div style="margin-top:14px;color:#b91c1c;">You have no saved templates yet. Build and save one in the schedule builder first.</div>')
            + '</div>'
            + '<div id="opr-body" style="padding:16px 22px;overflow:auto;flex:1;"><div style="color:#94a3b8;text-align:center;padding:30px;">Pick a date and template, then <strong>Load grid</strong>.</div></div>'
            + '<div style="padding:12px 22px;border-top:1px solid #eef2f7;display:flex;align-items:center;gap:10px;">'
            + '<div id="opr-summary" style="font-size:0.82rem;color:#64748b;"></div><div style="flex:1;"></div>'
            + '<button id="opr-cancel" style="padding:9px 18px;border:1px solid #d1d5db;border-radius:8px;background:#fff;font-weight:600;cursor:pointer;">Cancel</button>'
            + '<button id="opr-record" style="padding:9px 22px;border:none;border-radius:8px;background:#0f766e;color:#fff;font-weight:800;cursor:pointer;opacity:0.5;pointer-events:none;">Upload to date</button>'
            + '</div></div>';
        document.body.appendChild(ov);

        ov.querySelector('#opr-x').onclick = close;
        ov.querySelector('#opr-cancel').onclick = close;
        ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });

        var tpl = ov.querySelector('#opr-tpl'), loadBtn = ov.querySelector('#opr-load');
        if (tpl && loadBtn) {
            tpl.onchange = function () {
                var on = !!this.value; loadBtn.style.opacity = on ? '1' : '0.5'; loadBtn.style.pointerEvents = on ? 'auto' : 'none';
            };
            loadBtn.onclick = loadGrid;
        }
        var rec = ov.querySelector('#opr-record');
        if (rec) rec.onclick = doRecord;
    }

    function close() {
        var o = document.getElementById(OV_ID); if (o) o.remove();
        var s = document.getElementById(SUB_ID); if (s) s.remove();
        _dt = null; _acts = null; _leagues = null; _leagueSlots = null;
    }

    function loadGrid() {
        var dateEl = document.getElementById('opr-date'), tplEl = document.getElementById('opr-tpl');
        var guard = document.getElementById('opr-guard');
        var date = dateEl && dateEl.value, name = tplEl && tplEl.value;
        if (!date || !name) return;
        guard.textContent = 'Checking date…'; guard.style.color = '#64748b';

        dateHasSchedule(date).then(function (has) {
            if (has) {
                guard.style.color = '#b91c1c';
                guard.textContent = '⛔ ' + date + ' already has a schedule — pick another date (or delete that day first). Nothing was changed.';
                _dt = null; _setRecordEnabled(false);
                document.getElementById('opr-body').innerHTML = '<div style="color:#b91c1c;text-align:center;padding:30px;">This date is protected because it already has a schedule.</div>';
                return;
            }
            guard.textContent = '';
            var skel = templates()[name];
            var dt = {};
            try { if (window.DivisionTimesSystem && window.DivisionTimesSystem.buildFromSkeleton) dt = window.DivisionTimesSystem.buildFromSkeleton(skel, window.divisions || {}) || {}; } catch (e) {}
            if (!Object.keys(dt).length) {
                document.getElementById('opr-body').innerHTML = '<div style="color:#b91c1c;text-align:center;padding:30px;">This template has no period structure for your divisions.</div>';
                return;
            }
            _dateKey = date; _template = name; _dt = dt; _acts = {}; _leagues = {}; _leagueSlots = {};
            Object.keys(dt).forEach(function (div) {
                (dt[div] || []).forEach(function (slot, si) { if (isLeagueSlot(slot)) _leagueSlots[div + '|' + si] = true; });
            });
            _selectedDiv = Object.keys(dt).filter(function (d) { return bunksOf(d).length; })[0] || Object.keys(dt)[0];
            renderBody();
            _setRecordEnabled(true);
        });
    }

    function _setRecordEnabled(on) {
        var r = document.getElementById('opr-record'); if (!r) return;
        r.style.opacity = on ? '1' : '0.5'; r.style.pointerEvents = on ? 'auto' : 'none';
    }

    // ---- grade tabs + per-bunk grid ------------------------------------
    function renderBody() {
        var body = document.getElementById('opr-body'); if (!body) return;
        var divs = Object.keys(_dt).filter(function (d) { return bunksOf(d).length && (_dt[d] || []).length; });
        var tabs = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;">'
            + divs.map(function (d) {
                var c = divColor(d), on = d === _selectedDiv;
                return '<button class="opr-div" data-div="' + esc(d) + '" style="padding:6px 14px;border-radius:8px;border:2px solid ' + c + ';cursor:pointer;font-size:13px;font-weight:600;background:' + (on ? c : '#fff') + ';color:' + (on ? '#fff' : c) + ';">' + esc(d) + '</button>';
            }).join('') + '</div>';
        body.innerHTML = tabs + '<div id="opr-grid"></div>';
        body.querySelectorAll('.opr-div').forEach(function (b) { b.onclick = function () { _selectedDiv = b.dataset.div; renderBody(); }; });
        renderGrid();
        updateSummary();
    }

    function renderGrid() {
        var host = document.getElementById('opr-grid'); if (!host || !_selectedDiv) return;
        var div = _selectedDiv, periods = _dt[div] || [], bunks = bunksOf(div), c = divColor(div);
        if (!bunks.length) { host.innerHTML = '<div style="color:#94a3b8;padding:20px;">No bunks in this division.</div>'; return; }

        var h = '<div style="overflow-x:auto;border:1px solid #e5e7eb;border-radius:10px;">'
            + '<table style="border-collapse:collapse;width:100%;font-size:0.82rem;">'
            + '<thead><tr><th style="position:sticky;left:0;background:#f9fafb;text-align:left;padding:8px 10px;border-bottom:1px solid #e5e7eb;min-width:120px;">Period</th>'
            + bunks.map(function (b) { return '<th style="padding:7px 8px;border-bottom:1px solid #e5e7eb;border-left:1px solid #f1f5f9;background:' + c + ';color:#fff;font-weight:700;white-space:nowrap;">' + esc(b) + '</th>'; }).join('')
            + '</tr></thead><tbody>';

        periods.forEach(function (p, si) {
            var isLeague = !!_leagueSlots[div + '|' + si];
            h += '<tr>'
                + '<td style="position:sticky;left:0;background:#fff;padding:6px 10px;border-bottom:1px solid #f1f5f9;white-space:nowrap;">'
                + '<input class="opr-time" data-slot="' + si + '" value="' + minLabel(p.startMin) + '" title="Edit the start time to match your paper schedule" style="width:72px;height:26px;font-size:0.76rem;padding:2px 6px;border:1px solid #d1d5db;border-radius:6px;color:#111827;font-weight:600;">'
                + '<span style="color:#9ca3af;font-size:0.72rem;"> –' + minLabel(p.endMin) + '</span>'
                + '<div style="font-weight:400;color:#9ca3af;font-size:0.72rem;">' + esc(p.event || (isLeague ? 'League' : 'Period')) + '</div></td>';
            if (isLeague) {
                var lg = _leagues[div + '|' + si];
                var label = lg && lg.matches && lg.matches.length
                    ? lg.matches.map(function (m) { return esc(m.teamA + ' v ' + m.teamB + (m.winner ? ' ✓' : '')); }).join(', ')
                    : '＋ add matchup';
                h += '<td colspan="' + bunks.length + '" class="opr-lg" data-slot="' + si + '" style="padding:7px 10px;border-bottom:1px solid #f1f5f9;border-left:1px solid #f1f5f9;background:' + (lg ? '#e0f2fe' : '#f8fafc') + ';cursor:pointer;color:' + (lg ? '#075985' : '#64748b') + ';font-weight:600;">🏆 ' + label + '</td>';
            } else {
                bunks.forEach(function (b) {
                    var val = _acts[div + '|' + b + '|' + si] || '';
                    h += '<td class="opr-cell" data-bunk="' + esc(b) + '" data-slot="' + si + '" style="padding:5px 7px;border-bottom:1px solid #f1f5f9;border-left:1px solid #f8fafc;cursor:pointer;text-align:center;background:' + (val ? '#ecfdf5' : '#fff') + ';color:' + (val ? '#065f46' : '#cbd5e1') + ';font-weight:' + (val ? '600' : '400') + ';">' + (val ? esc(val) : '+') + '</td>';
                });
            }
            h += '</tr>';
        });
        h += '</tbody></table></div>';
        host.innerHTML = h;

        host.querySelectorAll('.opr-cell').forEach(function (td) {
            td.onclick = function () { pickActivity(div, td.dataset.bunk, parseInt(td.dataset.slot, 10)); };
        });
        host.querySelectorAll('.opr-lg').forEach(function (td) {
            td.onclick = function () { editLeague(div, parseInt(td.dataset.slot, 10)); };
        });
        // Editable start time — shift the period, preserving its length.
        host.querySelectorAll('.opr-time').forEach(function (inp) {
            inp.onchange = function () {
                var si = parseInt(inp.dataset.slot, 10), slot = (_dt[div] || [])[si];
                if (!slot) return;
                var nv = parseLabel(inp.value);
                if (nv == null) { inp.value = minLabel(slot.startMin); return; }
                var dur = (slot.endMin != null && slot.startMin != null && slot.endMin > slot.startMin) ? (slot.endMin - slot.startMin) : 45;
                slot.startMin = nv; slot.endMin = nv + dur;
                renderGrid();
            };
        });
    }

    function updateSummary() {
        var el = document.getElementById('opr-summary'); if (!el) return;
        var na = Object.keys(_acts).filter(function (k) { return _acts[k]; }).length;
        var nl = Object.keys(_leagues).filter(function (k) { return _leagues[k] && _leagues[k].matches && _leagues[k].matches.length; }).length;
        el.textContent = na + ' activit' + (na === 1 ? 'y' : 'ies') + ' · ' + nl + ' league game' + (nl === 1 ? '' : 's') + ' entered';
    }

    // ---- activity picker (per bunk) ------------------------------------
    function pickActivity(div, bunk, slot) {
        var period = (_dt[div] || [])[slot] || {};
        var cur = _acts[div + '|' + bunk + '|' + slot] || '';
        var opts = '<option value="">— (clear) —</option>' + activities().map(function (a) { return '<option value="' + esc(a) + '"' + (a === cur ? ' selected' : '') + '>' + esc(a) + '</option>'; }).join('');
        var o = subOverlay(
            '<div style="padding:16px 20px 8px;border-bottom:1px solid #eef2f7;"><div style="font-weight:800;color:#0f172a;">' + esc(bunk) + '</div>'
            + '<div style="color:#64748b;font-size:0.8rem;">' + esc(div) + ' · ' + minLabel(period.startMin) + '–' + minLabel(period.endMin) + '</div></div>'
            + '<div style="padding:16px 20px;"><label style="font-weight:700;font-size:0.82rem;color:#334155;display:block;margin-bottom:6px;">What did they do?</label>'
            + '<select id="opr-a" style="width:100%;padding:9px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:0.9rem;">' + opts + '</select></div>'
            + '<div style="padding:12px 20px;border-top:1px solid #eef2f7;display:flex;justify-content:flex-end;gap:10px;">'
            + '<button id="opr-a-x" style="padding:8px 16px;border:1px solid #d1d5db;border-radius:8px;background:#fff;font-weight:600;cursor:pointer;">Cancel</button>'
            + '<button id="opr-a-ok" style="padding:8px 18px;border:none;border-radius:8px;background:#0f766e;color:#fff;font-weight:700;cursor:pointer;">Set</button></div>', 420);
        o.querySelector('#opr-a-x').onclick = function () { o.remove(); };
        o.querySelector('#opr-a-ok').onclick = function () {
            var v = o.querySelector('#opr-a').value;
            if (v) _acts[div + '|' + bunk + '|' + slot] = v; else delete _acts[div + '|' + bunk + '|' + slot];
            o.remove(); renderGrid(); updateSummary();
        };
    }

    // ---- league editor (matchup + winner) ------------------------------
    function editLeague(div, slot) {
        var period = (_dt[div] || [])[slot] || {};
        var key = div + '|' + slot;
        var leagues = (window.LeaguesAPI && window.LeaguesAPI.getLeaguesForDivision) ? window.LeaguesAPI.getLeaguesForDivision(div) : [];
        if (!leagues.length) {
            var w = subOverlay('<div style="padding:24px;color:#b91c1c;text-align:center;">No leagues are configured for ' + esc(div) + '.</div><div style="padding:12px 20px;border-top:1px solid #eef2f7;text-align:right;"><button id="opr-lx" style="padding:8px 16px;border:1px solid #d1d5db;border-radius:8px;background:#fff;font-weight:600;cursor:pointer;">Close</button></div>', 480);
            w.querySelector('#opr-lx').onclick = function () { w.remove(); }; return;
        }
        var draft = _leagues[key] || { leagueName: leagues[0].name, matches: [] };
        var o = subOverlay(
            '<div style="padding:16px 20px 8px;border-bottom:1px solid #eef2f7;"><div style="font-weight:800;color:#0f172a;">🏆 League game — ' + esc(div) + '</div>'
            + '<div style="color:#64748b;font-size:0.8rem;">' + minLabel(period.startMin) + '–' + minLabel(period.endMin) + '</div></div>'
            + '<div style="padding:14px 20px;overflow:auto;">'
            + '<label style="font-weight:700;font-size:0.82rem;color:#334155;display:block;margin-bottom:5px;">League</label>'
            + '<select id="opr-lg-sel" style="width:100%;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:0.9rem;margin-bottom:12px;">'
            + leagues.map(function (l) { return '<option value="' + esc(l.name) + '"' + (l.name === draft.leagueName ? ' selected' : '') + '>' + esc(l.name) + '</option>'; }).join('') + '</select>'
            + '<div style="display:flex;align-items:center;margin-bottom:6px;"><strong style="font-size:0.82rem;color:#334155;">Matchups</strong><span style="flex:1;"></span><button id="opr-lg-add" style="padding:5px 12px;border:1px solid #0f766e;border-radius:7px;background:#f0fdfa;color:#0f766e;font-weight:700;font-size:0.8rem;cursor:pointer;">+ Add</button></div>'
            + '<div id="opr-lg-rows"></div></div>'
            + '<div style="padding:12px 20px;border-top:1px solid #eef2f7;display:flex;justify-content:flex-end;gap:10px;">'
            + '<button id="opr-lg-x" style="padding:8px 16px;border:1px solid #d1d5db;border-radius:8px;background:#fff;font-weight:600;cursor:pointer;">Cancel</button>'
            + '<button id="opr-lg-ok" style="padding:8px 18px;border:none;border-radius:8px;background:#0f766e;color:#fff;font-weight:700;cursor:pointer;">Save game</button></div>', 640);

        var sel = o.querySelector('#opr-lg-sel'), rows = o.querySelector('#opr-lg-rows');
        function lgByName(n) { for (var i = 0; i < leagues.length; i++) if (leagues[i].name === n) return leagues[i]; return leagues[0]; }
        function rowHtml(m) {
            var lg = lgByName(sel.value);
            var team = function (v) { return '<option value="">Team…</option>' + (lg.teams || []).map(function (t) { return '<option' + (t === v ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join(''); };
            var sport = '<option value="">Sport…</option>' + (lg.sports || []).map(function (s) { return '<option' + (s === (m.sport || '') ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('');
            function win(v, l) { return '<option value="' + v + '"' + ((m.winner || '') === v ? ' selected' : '') + '>' + l + '</option>'; }
            return '<div class="opr-lg-row" style="display:flex;gap:6px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">'
                + '<select class="opr-a" style="flex:1;min-width:88px;padding:6px;border:1px solid #d1d5db;border-radius:6px;font-size:0.8rem;">' + team(m.teamA || '') + '</select>'
                + '<span style="color:#94a3b8;font-size:0.78rem;">vs</span>'
                + '<select class="opr-b" style="flex:1;min-width:88px;padding:6px;border:1px solid #d1d5db;border-radius:6px;font-size:0.8rem;">' + team(m.teamB || '') + '</select>'
                + '<select class="opr-s" style="min-width:86px;padding:6px;border:1px solid #d1d5db;border-radius:6px;font-size:0.8rem;">' + sport + '</select>'
                + '<select class="opr-w" title="Who won" style="min-width:96px;padding:6px;border:1px solid #d1d5db;border-radius:6px;font-size:0.8rem;">' + win('', 'Result…') + win('A', 'Team A won') + win('B', 'Team B won') + win('T', 'Tie') + '</select>'
                + '<button class="opr-del" style="border:none;background:transparent;color:#ef4444;font-size:1.1rem;cursor:pointer;">×</button></div>';
        }
        function collect() {
            var out = [];
            rows.querySelectorAll('.opr-lg-row').forEach(function (r) {
                out.push({ teamA: r.querySelector('.opr-a').value, teamB: r.querySelector('.opr-b').value, sport: r.querySelector('.opr-s').value, winner: r.querySelector('.opr-w').value });
            });
            return out;
        }
        function paint(ms) {
            rows.innerHTML = ms.length ? ms.map(rowHtml).join('') : '<div style="color:#94a3b8;font-size:0.8rem;padding:6px 0;">No matchups yet — click “Add”.</div>';
            rows.querySelectorAll('.opr-del').forEach(function (b) { b.onclick = function () { var cur = collect(); var i = Array.prototype.indexOf.call(rows.querySelectorAll('.opr-del'), b); cur.splice(i, 1); paint(cur); }; });
        }
        paint(draft.matches && draft.matches.length ? draft.matches : []);
        o.querySelector('#opr-lg-add').onclick = function () { var cur = collect(); cur.push({ teamA: '', teamB: '', sport: '', winner: '' }); paint(cur); };
        sel.onchange = function () { paint(collect()); };
        o.querySelector('#opr-lg-x').onclick = function () { o.remove(); };
        o.querySelector('#opr-lg-ok').onclick = function () {
            var ms = collect().filter(function (m) { return m.teamA && m.teamB; });
            if (!ms.length) delete _leagues[key];
            else _leagues[key] = { leagueName: sel.value, matches: ms };
            o.remove(); renderGrid(); updateSummary();
        };
    }

    // =====================================================================
    // RECORD  (non-destructive: target date is guard-verified empty)
    // =====================================================================
    function doRecord() {
        if (!_dt || !_dateKey) return;
        var date = _dateKey;
        var na = Object.keys(_acts).filter(function (k) { return _acts[k]; }).length;
        var nl = Object.keys(_leagues).filter(function (k) { return _leagues[k] && _leagues[k].matches && _leagues[k].matches.length; }).length;
        if (!na && !nl) { toast('Nothing entered yet.', true); return; }

        // Re-check the guard right before writing — belt and suspenders.
        dateHasSchedule(date).then(function (has) {
            if (has) { toast('That date now has a schedule — recording cancelled. Nothing was changed.', true); return; }
            _commit(date, na, nl);
        });
    }

    function _commit(date, na, nl) {
        // Build scheduleAssignments (activities) for a viewable day.
        var assignments = {};
        Object.keys(_dt).forEach(function (div) {
            var periods = _dt[div] || [];
            bunksOf(div).forEach(function (bk) { assignments[bk] = new Array(periods.length).fill(null); });
        });
        Object.keys(_acts).forEach(function (k) {
            var act = _acts[k]; if (!act) return;
            var parts = k.split('|'), div = parts[0], bunk = parts[1], slot = parseInt(parts[2], 10);
            var period = (_dt[div] || [])[slot] || {};
            if (!assignments[bunk]) assignments[bunk] = [];
            assignments[bunk][slot] = {
                field: act, sport: act, continuation: false, _fixed: true, _activity: act,
                _location: null, _offPaper: true, _postEdit: true, _pinned: false,
                _startMin: period.startMin, _endMin: period.endMin, _editedAt: Date.now()
            };
        });

        // Build leagueAssignments for display.
        var leagueAssign = {};
        Object.keys(_leagues).forEach(function (k) {
            var d = _leagues[k]; if (!d || !d.matches || !d.matches.length) return;
            var parts = k.split('|'), div = parts[0], slot = parseInt(parts[1], 10);
            var period = (_dt[div] || [])[slot] || {};
            if (!leagueAssign[div]) leagueAssign[div] = {};
            leagueAssign[div][slot] = {
                leagueName: d.leagueName, sport: (d.matches[0].sport || ''),
                matchups: d.matches.map(function (m) { return { teamA: m.teamA, teamB: m.teamB, display: m.teamA + ' vs ' + m.teamB + (m.sport ? ' (' + m.sport + ')' : '') }; }),
                _startMin: period.startMin, _endMin: period.endMin
            };
        });

        // Take over the (empty, verified) target date, save, count, then restore view.
        var originalDate = window.currentScheduleDate;
        try {
            window.currentScheduleDate = date;
            window._scheduleAssignmentsDate = date;
            window.scheduleAssignments = assignments;
            window.leagueAssignments = leagueAssign;
            window.divisionTimes = _dt;

            // rotation recency stamps
            try {
                var hist = (window.loadRotationHistory && window.loadRotationHistory()) || { bunks: {}, leagues: {} };
                hist.bunks = hist.bunks || {}; var ts = Date.now();
                Object.keys(assignments).forEach(function (b) {
                    (assignments[b] || []).forEach(function (e) {
                        if (!e || e.continuation || !e._activity || String(e._activity).toLowerCase() === 'free') return;
                        hist.bunks[b] = hist.bunks[b] || {}; hist.bunks[b][e._activity] = ts;
                    });
                });
                window.saveRotationHistory && window.saveRotationHistory(hist);
            } catch (e) {}

            try { window.saveSchedule && window.saveSchedule(); } catch (e) { console.error('[OffPaper] saveSchedule failed:', e); }
            setTimeout(function () {
                try { window.SchedulerCoreUtils && window.SchedulerCoreUtils.rebuildHistoricalCounts && window.SchedulerCoreUtils.rebuildHistoricalCounts(true); } catch (e) {}
                try { window.RotationCloud && window.RotationCloud.save && window.RotationCloud.save(date, window.scheduleAssignments || {}); } catch (e) {}
            }, 0);

            // Leagues: standings + game counter.
            var leaguesDone = recordLeagues(date);

            // Restore the user's original view (its saved day reloads on render).
            window.currentScheduleDate = originalDate || date;
            window._scheduleAssignmentsDate = window.currentScheduleDate;
            try { window.updateTable && window.updateTable(); } catch (e) {}

            close();
            var msg = 'Uploaded to ' + date + ' — ' + na + ' activit' + (na === 1 ? 'y' : 'ies');
            if (leaguesDone) msg += ', ' + leaguesDone + ' league game' + (leaguesDone === 1 ? '' : 's') + ' (standings + counter updated)';
            toast(msg + '.');
            console.log('[OffPaper] Recorded', date, '—', na, 'activities,', leaguesDone, 'league games.');
        } catch (e) {
            console.error('[OffPaper] record failed:', e);
            window.currentScheduleDate = originalDate;
            toast('Recording failed — see console. Nothing partial was left on the live view.', true);
        }
    }

    // Standings (LeaguesAPI) + game counter (leagueHistory.gamesPerDate + roundState).
    function recordLeagues(date) {
        // Group entered games by league, ordered by time, so game numbers advance correctly.
        var byLeague = {}; // leagueName -> [{startMin, matches:[{teamA,teamB,sport,winner}]}]
        Object.keys(_leagues).forEach(function (k) {
            var d = _leagues[k]; if (!d || !d.matches || !d.matches.length) return;
            var parts = k.split('|'), div = parts[0], slot = parseInt(parts[1], 10);
            var period = (_dt[div] || [])[slot] || {};
            (byLeague[d.leagueName] = byLeague[d.leagueName] || []).push({ startMin: period.startMin || 0, matches: d.matches });
        });
        var leagueNames = Object.keys(byLeague);
        if (!leagueNames.length) return 0;

        var history = _loadLeagueHistory();
        var recorded = 0;

        leagueNames.forEach(function (lg) {
            var games = byLeague[lg].sort(function (a, b) { return a.startMin - b.startMin; });
            history.gameLog[lg] = history.gameLog[lg] || {};
            history.gamesPerDate[lg] = history.gamesPerDate[lg] || {};

            // cumulative games on EARLIER dates → first game number for this date
            var before = 0, gm = history.gamesPerDate[lg];
            Object.keys(gm).forEach(function (dd) { if (dd < date) before += (gm[dd] || 0); });

            var logArr = history.gameLog[lg][date] = []; // this date is authoritative (idempotent re-record)
            games.forEach(function (g, gi) {
                var gameNumber = before + gi + 1;
                var label = 'Game ' + gameNumber;
                // standings (scores encode the winner)
                var matches = g.matches.map(function (m) {
                    var sA = null, sB = null;
                    if (m.winner === 'A') { sA = 1; sB = 0; } else if (m.winner === 'B') { sA = 0; sB = 1; } else if (m.winner === 'T') { sA = 1; sB = 1; }
                    return { teamA: m.teamA, teamB: m.teamB, sport: m.sport || null, scoreA: sA, scoreB: sB };
                });
                if (window.LeaguesAPI && window.LeaguesAPI.recordManualGameResult) window.LeaguesAPI.recordManualGameResult(lg, date, label, matches);
                // gameLog (Play History + matchup variety) + matchup counts
                g.matches.forEach(function (m) {
                    logArr.push({ t1: m.teamA, t2: m.teamB, sport: m.sport || null, g: label });
                    var mk = lg + ':' + [m.teamA, m.teamB].sort().join('|');
                    history.matchupHistory[mk] = (history.matchupHistory[mk] || 0) + 1;
                });
                recorded++;
            });
            gm[date] = games.length;

            // advance the round pointer so the NEXT generated game is +N
            window.leagueRoundState = window.leagueRoundState || {};
            var ex = window.leagueRoundState[lg] || {};
            window.leagueRoundState[lg] = Object.assign({}, ex, {
                currentRound: before + games.length,
                lastScheduledDate: date,
                gamesPerDate: history.gamesPerDate[lg]
            });
        });

        _saveLeagueHistory(history);
        try { if (window.saveGlobalSettings) window.saveGlobalSettings('leagueRoundState', window.leagueRoundState); } catch (e) {}
        return recorded;
    }

    function _loadLeagueHistory() {
        var gs = (window.loadGlobalSettings && window.loadGlobalSettings()) || {};
        var cloud = gs.leagueHistory && Object.keys(gs.leagueHistory).length ? gs.leagueHistory : null, local = null;
        try { var raw = localStorage.getItem('campLeagueHistory_v2'); if (raw) local = JSON.parse(raw); } catch (e) {}
        var h;
        if (cloud && local) h = (Number(local._savedAt) || 0) > (Number(cloud._savedAt) || 0) ? local : cloud;
        else h = cloud || local || {};
        h.gameLog = h.gameLog || {}; h.gamesPerDate = h.gamesPerDate || {};
        h.matchupHistory = h.matchupHistory || {}; h.teamSports = h.teamSports || {};
        return h;
    }
    function _saveLeagueHistory(h) {
        try { h._savedAt = Date.now(); } catch (e) {}
        try { if (window.saveGlobalSettings) window.saveGlobalSettings('leagueHistory', h); } catch (e) {}
        try { localStorage.setItem('campLeagueHistory_v2', JSON.stringify(h)); } catch (e) {}
    }

    // =====================================================================
    // BUTTON INJECTION (next to Generate; survives toolbar re-renders)
    // =====================================================================
    function injectButton() {
        if (!isEnabled()) return;
        var gen = document.getElementById('da-generate-btn');
        if (!gen || document.getElementById(BTN_ID)) return;
        var b = document.createElement('button');
        b.id = BTN_ID;
        b.className = (gen.className || 'da-btn').replace('da-btn-success', 'da-btn-ghost');
        b.textContent = '🗓 Build Day';
        b.title = 'Record a day that was run off the system — activities + league games count into rotation & standings. Never overwrites an existing day.';
        b.onclick = open;
        gen.parentNode.insertBefore(b, gen);
    }
    function start() {
        if (!isEnabled()) return;
        injectButton();
        var host = document.getElementById('daily-adjustments-content') || document.body, sched = false;
        var obs = new MutationObserver(function () {
            if (sched) return; sched = true;
            requestAnimationFrame(function () { sched = false; injectButton(); });
        });
        try { obs.observe(host, { childList: true, subtree: true }); } catch (e) {}
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();

    window.OffPaperRecorder = { open: open };
    console.log('[OffPaperRecorder] v3 ready');
})();
