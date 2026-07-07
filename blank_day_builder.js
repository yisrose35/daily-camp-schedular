// =========================================================================
// blank_day_builder.js — "Build the Day (off-paper)"
//
// Lets a user pull in one of their saved TEMPLATES (skeletons) as a BLANK grid
// — carrying only the period TIMES and one slot per bunk — and hand-fill what
// each bunk actually did off-paper. NO legality checks, NO warnings: it is a
// pure data-entry grid. On "Save & Count" it writes the filled cells into the
// day's schedule and runs the SAME counting pipeline a generated day does
// (RotationCloud.save + rebuildHistoricalCounts), so everything the user enters
// flows into rotation fairness, recency, and the analytics report.
//
// Additive + self-contained. Injects its own button next to the Daily
// Adjustments "Generate" button; touches no scheduler/solver code.
// Killswitch: window.__blankDayBuilder = false  (disables the button entirely).
// =========================================================================
(function () {
    'use strict';

    var BTN_ID = 'bdb-open-btn';
    var OVERLAY_ID = 'bdb-overlay';
    var GRID_ID = 'bdb-grid';

    // Holds the divisionTimes we render/save against, so Save reads exactly
    // what the grid was built from (no re-derivation drift).
    var _builtDT = null;

    function isEnabled() { return window.__blankDayBuilder !== false; }

    // ---- small helpers -------------------------------------------------
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function minToLabel(m) {
        if (m == null || isNaN(m)) return '';
        var h = Math.floor(m / 60), mm = m % 60;
        var ap = h >= 12 ? 'pm' : 'am';
        var h12 = h % 12; if (h12 === 0) h12 = 12;
        return h12 + ':' + (mm < 10 ? '0' + mm : mm) + ap;
    }

    function currentDate() {
        return window.currentScheduleDate || new Date().toISOString().split('T')[0];
    }

    // Union of every schedulable activity: sports (field activities) + specials.
    // Same sources as SchedulerCoreUtils.getValidActivityNames, so every option
    // we offer is one the counting pipeline will actually accept.
    function getActivities() {
        var gs = (window.loadGlobalSettings && window.loadGlobalSettings()) || {};
        var app1 = gs.app1 || {};
        var set = {};
        (app1.fields || []).forEach(function (f) {
            (f && f.activities || []).forEach(function (a) { if (a) set[a] = true; });
        });
        var specials = (window.getAllSpecialActivities && window.getAllSpecialActivities())
            || app1.specialActivities || [];
        specials.forEach(function (s) { if (s && s.name) set[s.name] = true; });
        return Object.keys(set).sort(function (a, b) { return a.localeCompare(b); });
    }

    function getTemplates() {
        return (window.getSavedSkeletons && window.getSavedSkeletons()) || {};
    }

    function bunkName(b) {
        if (typeof b === 'string') return b;
        return b && (b.name || b.bunk || b.id) || '';
    }

    // Does the currently-loaded day already hold a real (non-Free) activity?
    function dateHasRealSchedule() {
        var sa = window.scheduleAssignments || {};
        for (var b in sa) {
            var arr = sa[b];
            if (!arr || typeof arr !== 'object') continue;
            for (var i in arr) {
                var e = arr[i];
                if (e && !e.continuation && e._activity
                    && String(e._activity).toLowerCase() !== 'free') return true;
            }
        }
        return false;
    }

    // ---- build the per-division blank grid from a chosen template -------
    function renderGridForTemplate(name) {
        var host = document.getElementById(GRID_ID);
        if (!host) return;
        _builtDT = null;

        var templates = getTemplates();
        var skeleton = templates[name];
        if (!skeleton || !skeleton.length) {
            host.innerHTML = '<div style="padding:24px;color:#6b7280;text-align:center;">Pick a template to start.</div>';
            return;
        }

        var dt = {};
        try {
            if (window.DivisionTimesSystem && window.DivisionTimesSystem.buildFromSkeleton) {
                dt = window.DivisionTimesSystem.buildFromSkeleton(skeleton, window.divisions || {}) || {};
            }
        } catch (e) {
            console.warn('[BlankDayBuilder] buildFromSkeleton failed:', e);
        }

        var divs = Object.keys(dt);
        if (!divs.length) {
            host.innerHTML = '<div style="padding:24px;color:#b91c1c;text-align:center;">This template has no period structure for your current divisions.</div>';
            return;
        }

        // Normalize each slot to a plain activity slot (keep times + label only)
        // so the saved day renders each filled cell as an ordinary activity.
        _builtDT = {};
        var activities = getActivities();
        var optsHtml = '<option value="">&mdash;</option>'
            + activities.map(function (a) { return '<option value="' + esc(a) + '">' + esc(a) + '</option>'; }).join('');

        var html = '';
        divs.forEach(function (div) {
            var periods = (dt[div] || []).map(function (p) {
                return { startMin: p.startMin, endMin: p.endMin, event: p.event || 'Period', type: 'activity' };
            });
            _builtDT[div] = periods;

            var bunksRaw = (window.divisions && window.divisions[div] && window.divisions[div].bunks) || [];
            var bunks = bunksRaw.map(bunkName).filter(Boolean);
            if (!bunks.length || !periods.length) return;

            html += '<div style="margin:0 0 22px;">'
                + '<div style="font-weight:800;color:#0f766e;font-size:0.95rem;margin:0 0 8px;">' + esc(div) + '</div>'
                + '<div style="overflow-x:auto;border:1px solid #e5e7eb;border-radius:10px;">'
                + '<table style="border-collapse:collapse;width:100%;font-size:0.82rem;">'
                + '<thead><tr>'
                + '<th style="position:sticky;left:0;background:#f9fafb;text-align:left;padding:8px 10px;border-bottom:1px solid #e5e7eb;min-width:110px;z-index:1;">Bunk</th>';
            periods.forEach(function (p) {
                html += '<th style="padding:6px 8px;border-bottom:1px solid #e5e7eb;border-left:1px solid #f1f5f9;white-space:nowrap;font-weight:600;color:#374151;">'
                    + minToLabel(p.startMin) + '&ndash;' + minToLabel(p.endMin)
                    + '<div style="font-weight:400;color:#9ca3af;font-size:0.72rem;">' + esc(p.event) + '</div></th>';
            });
            html += '</tr></thead><tbody>';
            bunks.forEach(function (bk, bi) {
                html += '<tr style="background:' + (bi % 2 ? '#fcfcfd' : '#fff') + ';">'
                    + '<td style="position:sticky;left:0;background:inherit;padding:6px 10px;font-weight:600;color:#111827;border-bottom:1px solid #f1f5f9;white-space:nowrap;">' + esc(bk) + '</td>';
                periods.forEach(function (p, si) {
                    html += '<td style="padding:3px 5px;border-left:1px solid #f8fafc;border-bottom:1px solid #f1f5f9;">'
                        + '<select class="bdb-cell" data-div="' + esc(div) + '" data-bunk="' + esc(bk) + '" data-slot="' + si + '" '
                        + 'style="width:100%;min-width:120px;padding:5px 6px;border:1px solid #d1d5db;border-radius:6px;font-size:0.8rem;background:#fff;">'
                        + optsHtml + '</select></td>';
                });
                html += '</tr>';
            });
            html += '</tbody></table></div></div>';
        });

        host.innerHTML = html || '<div style="padding:24px;color:#b91c1c;text-align:center;">No bunks found for this template\'s divisions.</div>';
    }

    // ---- collect + save + count ----------------------------------------
    function saveAndCount() {
        if (!_builtDT) { alert('Pick a template and fill in what was done first.'); return; }
        var dateKey = currentDate();

        // Build fresh scheduleAssignments keyed by bunk, indexed by slot.
        var assignments = {};
        Object.keys(_builtDT).forEach(function (div) {
            var periods = _builtDT[div] || [];
            var bunksRaw = (window.divisions && window.divisions[div] && window.divisions[div].bunks) || [];
            bunksRaw.map(bunkName).filter(Boolean).forEach(function (bk) {
                assignments[bk] = new Array(periods.length).fill(null);
            });
        });

        var filled = 0;
        var cells = document.querySelectorAll('#' + GRID_ID + ' select.bdb-cell');
        cells.forEach(function (sel) {
            var act = sel.value;
            if (!act) return; // blank slot → left uncounted
            var div = sel.getAttribute('data-div');
            var bk = sel.getAttribute('data-bunk');
            var slot = parseInt(sel.getAttribute('data-slot'), 10);
            var period = (_builtDT[div] || [])[slot] || {};
            if (!assignments[bk]) assignments[bk] = [];
            assignments[bk][slot] = {
                field: act,
                sport: act,
                continuation: false,
                _fixed: true,
                _activity: act,
                _displayName: null,
                _location: null,
                _offPaper: true,
                _postEdit: true,
                _pinned: false,
                _startMin: period.startMin,
                _endMin: period.endMin,
                _editedAt: Date.now()
            };
            filled++;
        });

        if (!filled) { alert('Nothing to save — fill in at least one activity.'); return; }

        // Commit into the live day and persist through the sanctioned path.
        window.currentScheduleDate = dateKey;
        window._scheduleAssignmentsDate = dateKey; // cross-date save-guard coherence
        window.scheduleAssignments = assignments;
        window.leagueAssignments = {};             // off-paper day carries no league games
        window.divisionTimes = _builtDT;

        // Rotation recency timestamps — parity with scheduler_core_main STEP 8.
        try {
            var hist = (window.loadRotationHistory && window.loadRotationHistory()) || { bunks: {}, leagues: {} };
            hist.bunks = hist.bunks || {};
            var ts = Date.now();
            Object.keys(assignments).forEach(function (bk) {
                (assignments[bk] || []).forEach(function (e) {
                    if (!e || e.continuation || !e._activity) return;
                    if (String(e._activity).toLowerCase() === 'free') return;
                    hist.bunks[bk] = hist.bunks[bk] || {};
                    hist.bunks[bk][e._activity] = ts;
                });
            });
            window.saveRotationHistory && window.saveRotationHistory(hist);
        } catch (e) { console.warn('[BlankDayBuilder] rotation history stamp failed:', e); }

        // Persist the day (local + cloud) and fire the count pipeline — exactly
        // the sequence runSkeletonOptimizer uses after a manual generation.
        try { window.updateTable && window.updateTable(); } catch (e) {}
        try { window.saveSchedule && window.saveSchedule(); } catch (e) { console.error('[BlankDayBuilder] saveSchedule failed:', e); }
        setTimeout(function () {
            try { window.SchedulerCoreUtils && window.SchedulerCoreUtils.rebuildHistoricalCounts && window.SchedulerCoreUtils.rebuildHistoricalCounts(true); } catch (e) { console.warn('[BlankDayBuilder] rebuild failed:', e); }
            try { window.RotationCloud && window.RotationCloud.save && window.RotationCloud.save(dateKey, window.scheduleAssignments || {}); } catch (e) { console.warn('[BlankDayBuilder] RotationCloud.save failed:', e); }
        }, 0);

        close();
        toast('Saved & counted ' + filled + ' activit' + (filled === 1 ? 'y' : 'ies') + ' for ' + dateKey + '.');
        console.log('[BlankDayBuilder] Saved off-paper day', dateKey, '—', filled, 'activities counted.');
    }

    // ---- modal shell ---------------------------------------------------
    function close() {
        var o = document.getElementById(OVERLAY_ID);
        if (o) o.remove();
        _builtDT = null;
    }

    function toast(msg) {
        try {
            var t = document.createElement('div');
            t.textContent = msg;
            t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#0f766e;color:#fff;padding:12px 20px;border-radius:10px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:0.9rem;font-weight:600;box-shadow:0 10px 30px rgba(0,0,0,0.25);z-index:100050;';
            document.body.appendChild(t);
            setTimeout(function () { try { t.remove(); } catch (e) {} }, 3200);
        } catch (e) {}
    }

    function open() {
        if (document.getElementById(OVERLAY_ID)) return;
        var dateKey = currentDate();
        var templates = getTemplates();
        var names = Object.keys(templates);

        if (dateHasRealSchedule()) {
            var ok = window.confirm('This date (' + dateKey + ') already has a schedule.\n\nBuilding a day off-paper will REPLACE it with what you enter. Continue?');
            if (!ok) return;
        }

        var overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.55);z-index:100001;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:20px;';

        var tplOptions = names.length
            ? '<option value="">Choose a template&hellip;</option>' + names.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join('')
            : '';

        var body = names.length
            ? '<div id="' + GRID_ID + '"><div style="padding:24px;color:#6b7280;text-align:center;">Pick a template to start.</div></div>'
            : '<div style="padding:24px;color:#b91c1c;text-align:center;">You have no saved templates yet. Build and save one in the schedule builder first, then come back.</div>';

        overlay.innerHTML =
            '<div role="dialog" aria-modal="true" style="background:#fff;border-radius:16px;max-width:1080px;width:100%;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,0.32);overflow:hidden;">'
            + '<div style="padding:18px 22px 14px;border-bottom:1px solid #eef2f7;">'
            + '<div style="display:flex;align-items:center;gap:10px;">'
            + '<div style="font-size:1.15rem;font-weight:800;color:#0f172a;">🗓 Build the Day <span style="font-weight:600;color:#64748b;font-size:0.9rem;">(off-paper)</span></div>'
            + '<div style="flex:1;"></div>'
            + '<button id="bdb-x" style="border:none;background:transparent;font-size:1.4rem;line-height:1;color:#94a3b8;cursor:pointer;">&times;</button>'
            + '</div>'
            + '<div style="color:#64748b;font-size:0.85rem;margin-top:4px;">Pick a template, then enter what each bunk actually did for <strong>' + esc(dateKey) + '</strong>. No rules are applied — leave a slot blank to skip it. Saving counts everything into rotation.</div>'
            + (names.length ? '<div style="margin-top:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">'
                + '<span style="font-weight:700;color:#334155;font-size:0.88rem;">Template:</span>'
                + '<select id="bdb-tpl" style="padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:0.9rem;min-width:220px;">' + tplOptions + '</select>'
                + '</div>' : '')
            + '</div>'
            + '<div style="padding:18px 22px;overflow:auto;flex:1;">' + body + '</div>'
            + '<div style="padding:14px 22px;border-top:1px solid #eef2f7;display:flex;justify-content:flex-end;gap:10px;">'
            + '<button id="bdb-cancel" style="padding:9px 18px;border:1px solid #d1d5db;border-radius:8px;background:#fff;color:#374151;font-size:0.9rem;font-weight:600;cursor:pointer;">Cancel</button>'
            + '<button id="bdb-save" style="padding:9px 20px;border:none;border-radius:8px;background:#0f766e;color:#fff;font-size:0.9rem;font-weight:700;cursor:pointer;' + (names.length ? '' : 'opacity:0.5;pointer-events:none;') + '">Save &amp; Count</button>'
            + '</div>'
            + '</div>';

        document.body.appendChild(overlay);

        overlay.querySelector('#bdb-x').onclick = close;
        overlay.querySelector('#bdb-cancel').onclick = close;
        var saveBtn = overlay.querySelector('#bdb-save');
        if (saveBtn) saveBtn.onclick = saveAndCount;
        var tplSel = overlay.querySelector('#bdb-tpl');
        if (tplSel) tplSel.onchange = function () { renderGridForTemplate(this.value); };
        overlay.addEventListener('mousedown', function (ev) { if (ev.target === overlay) close(); });
    }

    // ---- button injection (survives DA toolbar re-renders) -------------
    function injectButton() {
        if (!isEnabled()) return;
        var gen = document.getElementById('da-generate-btn');
        if (!gen || document.getElementById(BTN_ID)) return;
        var b = document.createElement('button');
        b.id = BTN_ID;
        b.className = gen.className.replace('da-btn-success', 'da-btn-ghost') || 'da-btn';
        b.textContent = '🗓 Build Day';
        b.title = 'Fill in a blank template of what each bunk actually did off-paper — counts into rotation';
        b.onclick = open;
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

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startObserver);
    } else {
        startObserver();
    }

    window.BlankDayBuilder = { open: open };
    console.log('[BlankDayBuilder] Module ready');
})();
