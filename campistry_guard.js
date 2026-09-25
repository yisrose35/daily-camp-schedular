// ============================================================================
// campistry_guard.js — Campistry Guard (Lifeguard & Waterfront) v1.0
// ============================================================================
// Three views:
//   roster       — which bunks are at the pool RIGHT NOW (derived from today's
//                  saved schedule, never started/stopped by hand), their
//                  campers, clearance, buddy, and in/out/bathroom status.
//   buddy-pairs  — pair campers within a bunk (Lite's camper sheet edits the
//                  same pairs from the counselor side).
//   swim-levels  — every camper's shallow/deep pool clearance, one-tap toggle.
//
// Data:
//   Camper roster     — app1.camperRoster (Me). poolClearance lives ON the
//                       camper record ('shallow' | 'deep', default 'shallow'),
//                       separate from the swimLevel skill rating.
//   campistryGuard    — camp_state_kv key:
//                       { buddyPairs: { [bunk]: [[a,b],…] },
//                         checkins:   { [YYYY-MM-DD]: { [camper]: {status, updatedAt} } } }
//   Today's schedule  — read-only via campistry_live_schedule_reader.js (the
//                       same loader Live uses). Guard never writes schedules.
// ============================================================================

(function() {
    'use strict';

    var STORAGE_KEY = 'campGlobalSettings_v1';
    var GUARD_KEY   = 'campistryGuard';
    var STATUSES    = [['in','In water'],['out','Out'],['bathroom','Bathroom']];

    var _schedule = null;       // LiveScheduleReader result for today
    var _schedLoading = false;
    var _pairBunk = '';         // Buddy Pairs: selected bunk
    var _pairPick = null;       // Buddy Pairs: first tapped camper
    var _levelQuery = '';

    // ── Data access ───────────────────────────────────────────────────────
    function readGlobal() {
        try { if (typeof window.loadGlobalSettings === 'function') return window.loadGlobalSettings() || {}; } catch(e) {}
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch(e) { return {}; }
    }
    function allRoster() { var g = readGlobal(); return (g.app1 && g.app1.camperRoster) || {}; }
    // Active campers only: unenrolled and not-at-camp-today are dropped, same
    // rule Health/Live use, so a lifeguard's list is who can actually be here.
    function getRoster() {
        var all = allRoster(), out = {};
        var P = window.CampistryPresence, gate = !!(P && P.hasDates && P.hasDates());
        Object.keys(all).forEach(function(n){ var c = all[n]; if (!c || c.unenrolled) return; if (gate && !P.isHere(n)) return; out[n] = c; });
        return out;
    }
    function getStructure() { return readGlobal().campStructure || {}; }
    function _lbl(key) { return String(key == null ? '' : key).replace(/\s#\d+$/, ''); }

    // Every bunk in camp-structure order, falling back to roster bunks.
    function allBunks() {
        var s = getStructure(), out = [], seen = {};
        Object.keys(s).forEach(function(d){
            var grades = (s[d] && s[d].grades) || {};
            Object.keys(grades).forEach(function(gr){
                ((grades[gr] || {}).bunks || []).forEach(function(b){ b = String(b); if (!seen[b]) { seen[b] = 1; out.push(b); } });
            });
        });
        var r = getRoster();
        Object.keys(r).forEach(function(n){ var b = r[n].bunk; if (b && !seen[b]) { seen[b] = 1; out.push(String(b)); } });
        return out;
    }
    function campersInBunk(bunk) {
        var r = getRoster();
        return Object.keys(r).filter(function(n){ return String(r[n].bunk) === String(bunk); }).sort(function(a,b){ return _lbl(a).localeCompare(_lbl(b)); });
    }

    function getGuard() {
        var g = readGlobal()[GUARD_KEY] || {};
        return { buddyPairs: g.buddyPairs || {}, checkins: g.checkins || {} };
    }
    // Read-modify-write: re-read the latest copy, apply fn, save. Never
    // replaces other dates' check-ins or other bunks' pairs.
    function updateGuard(fn) {
        var d = getGuard();
        fn(d);
        try {
            if (typeof window.saveGlobalSettings === 'function') window.saveGlobalSettings(GUARD_KEY, d);
            else { var g = readGlobal(); g[GUARD_KEY] = d; localStorage.setItem(STORAGE_KEY, JSON.stringify(g)); }
        } catch(e) { console.error('[Guard] save failed', e); toast('Could not save', true); }
        return d;
    }

    function todayKey() {
        if (window.LiveScheduleReader && window.LiveScheduleReader.todayKey) return window.LiveScheduleReader.todayKey();
        var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    }
    function buddyOf(guard, bunk, name) {
        var pairs = (guard.buddyPairs || {})[bunk] || [];
        for (var i = 0; i < pairs.length; i++) {
            if (pairs[i][0] === name) return pairs[i][1];
            if (pairs[i][1] === name) return pairs[i][0];
        }
        return null;
    }
    function clearanceOf(c) { return (c && c.poolClearance === 'deep') ? 'deep' : 'shallow'; }

    // ── Helpers ───────────────────────────────────────────────────────────
    function esc(s) { if (s == null) return ''; var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function attr(s) { return esc(s).replace(/"/g, '&quot;'); }
    function getCurrentTimeMinutes() { var now = new Date(); return now.getHours() * 60 + now.getMinutes(); }
    function minLabel(m) {
        if (window.CampistryLiveLocator && window.CampistryLiveLocator.minutesToTimeLabel) return window.CampistryLiveLocator.minutesToTimeLabel(m);
        var h = Math.floor(m/60), mm = m%60, ap = h >= 12 ? 'PM' : 'AM'; h = h%12 || 12; return h + ':' + String(mm).padStart(2,'0') + ' ' + ap;
    }
    function $(id) { return document.getElementById(id); }
    function toast(msg, err) {
        var t = $('guardToast'); if (!t) return;
        t.textContent = msg; t.className = 'toast show' + (err ? ' error' : '');
        clearTimeout(toast._t); toast._t = setTimeout(function(){ t.className = 'toast'; }, 2200);
    }
    function clearanceBadge(c) {
        var cl = clearanceOf(c);
        return '<span class="badge guard-cl guard-cl-' + cl + '">' + (cl === 'deep' ? 'Deep' : 'Shallow') + '</span>';
    }

    // ── Schedule: who is at the pool right now ────────────────────────────
    // Same field-reading pattern as rules.js blockMatchesDescriptor('swim'),
    // plus swim_elective hybrids and the saved assignment's activity name.
    function isSwim(x) {
        if (!x) return false;
        var t = String(x.type || '').toLowerCase(), ev = String(x.event || '').toLowerCase().trim();
        if (t === 'swim' || t === 'swim_elective' || ev === 'swim') return true;
        var act = String(x._activity || x.sport || '').toLowerCase().trim();
        return act === 'swim';
    }
    function loadSchedule(force) {
        if (_schedLoading || (_schedule && !force) || !window.LiveScheduleReader) return;
        _schedLoading = true;
        var ready = (window.CampistryDB && window.CampistryDB.ready && window.CampistryDB.ready.then) ? window.CampistryDB.ready : Promise.resolve();
        ready.then(function(){ return window.LiveScheduleReader.loadToday(getStructure()); })
            .then(function(d){
                _schedule = d || {};
                if (window.CampistryLiveLocator && window.CampistryLiveLocator.setScheduleData) window.CampistryLiveLocator.setScheduleData(_schedule);
            }, function(e){ console.warn('[Guard] schedule load failed', e); _schedule = {}; })
            .then(function(){ _schedLoading = false; renderRoster(); });
    }
    // For one bunk at time t: the swim block it's in, or null.
    // Mirrors campistry_live_locator.js resolveCamperAt's slot matching.
    function swimBlockFor(bunk, t) {
        var S = _schedule || {};
        var list = (S.scheduleAssignments || {})[bunk] || [];
        var div = (S.bunkToDivision || {})[bunk];
        var slots = (S.divisionTimes || {})[div] || [];
        var a = null, ds = null, idx = -1, i;
        for (i = 0; i < list.length; i++) {
            var x = list[i]; if (!x || x.continuation) continue;
            var s = x._startMin != null ? x._startMin : x._blockStart, e = x._endMin;
            if (s != null && e != null && s <= t && t < e) { a = x; idx = i; break; }
        }
        for (i = 0; i < slots.length; i++) { if (slots[i].startMin <= t && t < slots[i].endMin) { ds = slots[i]; if (idx < 0) idx = i; break; } }
        if (!a && idx >= 0) {
            a = list[idx] || null;
            for (var k = idx; a && a.continuation && k > 0; ) { k--; if (list[k] && !list[k].continuation) a = list[k]; }
        }
        if (!isSwim(a) && !isSwim(ds)) return null;
        var start = (a && a._startMin != null) ? a._startMin : (ds ? ds.startMin : null);
        var end = (a && a._endMin != null) ? a._endMin : (ds ? ds.endMin : null);
        var loc = (a && a.swimLocation) || (ds && ds.swimLocation) || 'Pool';
        return { division: div, location: String(loc), start: start, end: end };
    }
    function atPoolNow() {
        var t = getCurrentTimeMinutes(), groups = {}, order = [];
        allBunks().forEach(function(b){
            var hit = swimBlockFor(b, t); if (!hit) return;
            if (!groups[hit.location]) { groups[hit.location] = []; order.push(hit.location); }
            groups[hit.location].push({ bunk: b, division: hit.division, start: hit.start, end: hit.end });
        });
        return order.map(function(l){ return { location: l, bunks: groups[l] }; });
    }

    // ── View 1: Live Roster ───────────────────────────────────────────────
    function renderRoster() {
        var host = $('guardRosterBody'); if (!host) return;
        var clock = $('guardClock'); if (clock) clock.textContent = new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'}) + ' · ' + minLabel(getCurrentTimeMinutes());
        if (!_schedule) { host.innerHTML = '<div class="card"><div class="empty-state">Loading today\'s schedule…</div></div>'; loadSchedule(); return; }
        var groups = atPoolNow();
        var inCount = 0, total = 0;
        if (!groups.length) {
            host.innerHTML = '<div class="card"><div class="empty-state"><strong>No bunks scheduled for swim right now</strong><br>Bunks appear here automatically when today\'s schedule has them at swim.</div></div>';
            setStats(0, 0, 0); return;
        }
        var roster = getRoster(), guard = getGuard(), day = guard.checkins[todayKey()] || {};
        var h = '';
        groups.forEach(function(g){
            h += '<div class="card"><div class="card-header"><h2>' + esc(g.location) + '</h2><span class="badge badge-blue">' + g.bunks.length + ' bunk' + (g.bunks.length === 1 ? '' : 's') + '</span></div><div class="card-body">';
            g.bunks.forEach(function(b){
                var names = campersInBunk(b.bunk);
                h += '<div class="guard-bunk"><div class="guard-bunk-head"><span class="guard-bunk-name">' + esc(b.bunk) + '</span>' +
                    (b.division ? '<span class="guard-muted">' + esc(b.division) + '</span>' : '') +
                    (b.start != null ? '<span class="guard-muted">' + esc(minLabel(b.start) + ' – ' + minLabel(b.end)) + '</span>' : '') + '</div>';
                if (!names.length) h += '<div class="guard-muted" style="padding:6px 0;">No campers on this bunk</div>';
                names.forEach(function(n){
                    total++;
                    var st = (day[n] && day[n].status) || 'out'; if (st === 'in') inCount++;
                    var bud = buddyOf(guard, b.bunk, n);
                    h += '<div class="guard-row"><div class="guard-row-main"><div class="guard-name">' + esc(_lbl(n)) + ' ' + clearanceBadge(roster[n]) + '</div>' +
                        '<div class="guard-buddy' + (bud ? '' : ' none') + '">' + (bud ? 'Buddy: ' + esc(_lbl(bud)) : 'No buddy') + '</div></div>' +
                        '<div class="guard-seg">' + STATUSES.map(function(s){
                            return '<button class="guard-seg-btn' + (st === s[0] ? ' active s-' + s[0] : '') + '" data-camper="' + attr(n) + '" data-status="' + s[0] + '">' + s[1] + '</button>';
                        }).join('') + '</div></div>';
                });
                h += '</div>';
            });
            h += '</div></div>';
        });
        host.innerHTML = h;
        var bath = Object.keys(day).filter(function(n){ return day[n].status === 'bathroom'; }).length;
        setStats(total, inCount, bath);
        host.querySelectorAll('.guard-seg-btn').forEach(function(btn){
            btn.addEventListener('click', function(){
                var n = btn.getAttribute('data-camper'), s = btn.getAttribute('data-status'), dk = todayKey();
                updateGuard(function(d){ d.checkins[dk] = d.checkins[dk] || {}; d.checkins[dk][n] = { status: s, updatedAt: new Date().toISOString() }; });
                renderRoster();
            });
        });
    }
    function setStats(total, inW, bath) {
        if ($('gStatAtPool')) $('gStatAtPool').textContent = total;
        if ($('gStatIn')) $('gStatIn').textContent = inW;
        if ($('gStatBath')) $('gStatBath').textContent = bath;
    }

    // ── View 2: Buddy Pairs ───────────────────────────────────────────────
    function renderPairs() {
        var sel = $('guardPairBunk'), host = $('guardPairsBody'); if (!sel || !host) return;
        var bunks = allBunks();
        if (!_pairBunk || bunks.indexOf(_pairBunk) < 0) _pairBunk = bunks[0] || '';
        sel.innerHTML = bunks.map(function(b){ return '<option value="' + attr(b) + '"' + (b === _pairBunk ? ' selected' : '') + '>' + esc(b) + '</option>'; }).join('');
        if (!_pairBunk) { host.innerHTML = '<div class="empty-state">No bunks set up yet — add them in Campistry Me.</div>'; return; }
        var names = campersInBunk(_pairBunk), guard = getGuard(), roster = getRoster();
        var pairs = (guard.buddyPairs[_pairBunk] || []).filter(function(p){ return p && names.indexOf(p[0]) >= 0 && names.indexOf(p[1]) >= 0; });
        var paired = {}; pairs.forEach(function(p){ paired[p[0]] = 1; paired[p[1]] = 1; });
        var free = names.filter(function(n){ return !paired[n]; });
        var h = '<div class="card"><div class="card-header"><h2>Pairs</h2><span class="badge badge-neutral">' + pairs.length + '</span></div><div class="card-body">';
        h += pairs.length ? pairs.map(function(p, i){
            return '<button class="guard-pair" data-unpair="' + i + '" title="Tap to unpair"><span>' + esc(_lbl(p[0])) + '</span><span class="guard-pair-amp">&amp;</span><span>' + esc(_lbl(p[1])) + '</span><span class="guard-pair-x">Unpair</span></button>';
        }).join('') : '<div class="guard-muted">No pairs yet for this bunk.</div>';
        h += '</div></div>';
        h += '<div class="card"><div class="card-header"><h2>Unpaired</h2><span class="badge ' + (free.length ? 'badge-amber' : 'badge-green') + '">' + free.length + '</span></div><div class="card-body">';
        h += '<div class="guard-muted" style="margin-bottom:10px;">' + (_pairPick ? 'Now tap the buddy for <strong>' + esc(_lbl(_pairPick)) + '</strong> (tap again to cancel).' : 'Tap two campers to pair them.') + '</div>';
        h += free.length ? '<div class="guard-chips">' + free.map(function(n){
            return '<button class="guard-chip' + (n === _pairPick ? ' picked' : '') + '" data-pick="' + attr(n) + '">' + esc(_lbl(n)) + ' ' + clearanceBadge(roster[n]) + '</button>';
        }).join('') + '</div>' : '<div class="guard-muted">Everyone on this bunk has a buddy.</div>';
        h += '</div></div>';
        host.innerHTML = h;
        host.querySelectorAll('[data-unpair]').forEach(function(b){
            b.addEventListener('click', function(){
                var p = pairs[+b.getAttribute('data-unpair')]; if (!p) return;
                updateGuard(function(d){ d.buddyPairs[_pairBunk] = (d.buddyPairs[_pairBunk] || []).filter(function(q){ return !(q[0] === p[0] && q[1] === p[1]); }); });
                toast('Unpaired ' + _lbl(p[0]) + ' & ' + _lbl(p[1])); renderPairs();
            });
        });
        host.querySelectorAll('[data-pick]').forEach(function(b){
            b.addEventListener('click', function(){
                var n = b.getAttribute('data-pick');
                if (!_pairPick) { _pairPick = n; renderPairs(); return; }
                if (_pairPick === n) { _pairPick = null; renderPairs(); return; }
                var a = _pairPick; _pairPick = null;
                updateGuard(function(d){
                    var list = (d.buddyPairs[_pairBunk] || []).filter(function(q){ return q.indexOf(a) < 0 && q.indexOf(n) < 0; });
                    list.push([a, n]); d.buddyPairs[_pairBunk] = list;
                });
                toast('Paired ' + _lbl(a) + ' & ' + _lbl(n)); renderPairs();
            });
        });
    }

    // ── View 3: Swim Levels (pool clearance) ──────────────────────────────
    function renderLevels() {
        var host = $('guardLevelsBody'); if (!host) return;
        var roster = getRoster(), q = _levelQuery.toLowerCase(), h = '', deep = 0, total = 0;
        allBunks().forEach(function(b){
            var names = campersInBunk(b).filter(function(n){ return !q || n.toLowerCase().indexOf(q) >= 0; });
            if (!names.length) return;
            h += '<tr class="guard-group-row"><td colspan="3">' + esc(b) + '</td></tr>';
            names.forEach(function(n){
                var c = roster[n], cl = clearanceOf(c); total++; if (cl === 'deep') deep++;
                h += '<tr><td>' + esc(_lbl(n)) + '</td><td>' + clearanceBadge(c) + (c.swimLevel ? ' <span class="guard-muted">' + esc(c.swimLevel) + '</span>' : '') + '</td>' +
                    '<td style="text-align:right;"><button class="btn btn-secondary btn-sm" data-toggle="' + attr(n) + '">Make ' + (cl === 'deep' ? 'shallow' : 'deep') + '</button></td></tr>';
            });
        });
        host.innerHTML = total
            ? '<table class="data-table"><thead><tr><th>Camper</th><th>Clearance</th><th></th></tr></thead><tbody>' + h + '</tbody></table>'
            : '<div class="empty-state">' + (q ? 'No campers match.' : 'No campers on the roster yet.') + '</div>';
        if ($('guardLevelsSummary')) $('guardLevelsSummary').textContent = total + ' campers · ' + deep + ' deep-water cleared';
        host.querySelectorAll('[data-toggle]').forEach(function(b){
            b.addEventListener('click', function(){ toggleClearance(b.getAttribute('data-toggle')); });
        });
    }
    // Direct toggle on the camper record in app1.camperRoster — the same
    // record Me's editCamper/saveCamper edits — merged, never replaced.
    function toggleClearance(name) {
        var g = readGlobal(), app1 = Object.assign({}, g.app1 || {}), r = Object.assign({}, app1.camperRoster || {});
        if (!r[name]) { toast('Camper not found', true); return; }
        var next = clearanceOf(r[name]) === 'deep' ? 'shallow' : 'deep';
        r[name] = Object.assign({}, r[name], { poolClearance: next });
        app1.camperRoster = r;
        try {
            if (typeof window.saveGlobalSettings === 'function') window.saveGlobalSettings('app1', app1);
            else { g.app1 = app1; localStorage.setItem(STORAGE_KEY, JSON.stringify(g)); }
            toast(_lbl(name) + ' → ' + next);
        } catch(e) { console.error('[Guard] clearance save failed', e); toast('Could not save', true); }
        renderLevels();
    }

    // ── Page switching ────────────────────────────────────────────────────
    function onPageChange(p) {
        if (p === 'roster') renderRoster();
        else if (p === 'buddy-pairs') renderPairs();
        else if (p === 'swim-levels') renderLevels();
    }
    function refreshActive() {
        var a = document.querySelector('.guard-page.active');
        if (a && a.id) onPageChange(a.id.replace('page-', ''));
    }
    function init() {
        var sel = $('guardPairBunk');
        if (sel) sel.addEventListener('change', function(){ _pairBunk = sel.value; _pairPick = null; renderPairs(); });
        var s = $('guardLevelSearch');
        if (s) s.addEventListener('input', function(){ _levelQuery = s.value.trim(); renderLevels(); });
        var r = $('guardRefreshBtn');
        if (r) r.addEventListener('click', function(){ loadSchedule(true); });
        loadSchedule();
        refreshActive();
        // The pool changes as the clock moves: re-evaluate every 30s, reload the
        // saved schedule every 5 min in case the office regenerated it.
        setInterval(function(){ var a = document.querySelector('.guard-page.active'); if (a && a.id === 'page-roster') renderRoster(); }, 30000);
        setInterval(function(){ loadSchedule(true); }, 300000);
    }

    window.CampistryGuard = { init: init, onPageChange: onPageChange, refreshActive: refreshActive, reloadSchedule: function(){ loadSchedule(true); } };
})();
