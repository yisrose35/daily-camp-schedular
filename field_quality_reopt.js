// ============================================================================
// FieldQualityReopt — shared, schedule-level field-quality re-optimization
// ============================================================================
// Field Quality Groups assign the best-ranked field in a group to the most
// senior (oldest) grade. The AUTO builder enforces this with a final post-pass
// (scheduler_core_auto.js `_runFieldQualityReopt`). The MANUAL builder — and its
// Smart Tile auto-fill (smart_logic_adapter.js / scheduler_core_main.js) — had
// NO such pass, so manual/smart-tile output ignored field quality entirely.
//
// This module ports the auto algorithm into a standalone, engine-agnostic pass
// that operates purely on `window.scheduleAssignments` (time-based, not slot-
// index based), so the manual path can run the exact same three phases:
//
//   Phase A  pull each grouped-field block to a strictly better-ranked field in
//            its group when that field is free (or same-grade / same-activity
//            shareable within capacity) and the move passes validation.
//   Phase B  within each (group, EXACT time window) re-pair fields among the
//            co-located placements so the most senior grade holds the best rank.
//   Phase C  staggered-overlap seniority swap — swap fields between two OVERLAP-
//            ping (not exact) placements when the senior grade sits on a worse
//            rank and both sides re-validate.
//
// It rebuilds its ledger from scheduleAssignments on every run, so it is safe
// and idempotent. No-op when no field groups are configured.
//
// Seniority comes from window.getDivisionAgeOrder (oldest first) — the same
// source the auto pass and the FQ audit use, so all three stay in lock-step.
// ============================================================================

(function () {
    "use strict";

    function _loadSettings() {
        try { return (window.loadGlobalSettings && window.loadGlobalSettings()) || {}; }
        catch (_e) { return {}; }
    }

    // Self-contained access/time validator — mirrors the field-level checks in
    // scheduler_core_auto.js `_validateWritePlacement` (disabled fields, daily
    // sport disables, field access restrictions, exclusive field preferences,
    // grade-scoped field time rules). Returns null when the placement is legal,
    // or a short reason string when it is blocked. Rotation/special gates are
    // intentionally omitted: this pass only changes the FIELD of an existing
    // placement, never the activity, so per-activity rotation state is untouched.
    function _defaultValidate(fieldName, activityName, grade, bunk, startMin, endMin) {
        if (!fieldName || fieldName === 'Free') return null;
        var app1 = _loadSettings().app1 || {};
        var fld = (app1.fields || []).find(function (f) { return f && f.name === fieldName; });

        if (window.currentDisabledFields && window.currentDisabledFields.indexOf(fieldName) !== -1) {
            return 'field disabled today';
        }

        // Daily per-field sport disable (Resources panel → per-date overrides).
        if (activityName) {
            var dailySports = null;
            try {
                var dd = window.loadCurrentDailyData && window.loadCurrentDailyData();
                if (dd && dd.dailyDisabledSportsByField && dd.dailyDisabledSportsByField[fieldName]) {
                    dailySports = dd.dailyDisabledSportsByField[fieldName];
                } else {
                    var dk = window.currentScheduleDate || '';
                    if (dk) {
                        var stored = localStorage.getItem('campResourceOverrides_' + dk);
                        if (stored) {
                            var parsed = JSON.parse(stored);
                            var ls = parsed && parsed.dailyDisabledSportsByField && parsed.dailyDisabledSportsByField[fieldName];
                            if (Array.isArray(ls)) dailySports = ls;
                        }
                    }
                }
            } catch (_e) {}
            if (Array.isArray(dailySports) && dailySports.some(function (s) {
                return String(s).toLowerCase().trim() === String(activityName).toLowerCase().trim();
            })) return 'sport disabled on this field today';
        }

        if (!fld) return null; // field has no config row → nothing field-level to block

        // Field access restrictions (grade + bunk). Empty divisions = misconfig → open.
        if (fld.accessRestrictions && fld.accessRestrictions.enabled
            && fld.accessRestrictions.divisions
            && Object.keys(fld.accessRestrictions.divisions).length > 0) {
            var divs = fld.accessRestrictions.divisions;
            var gk = String(grade);
            if (!(gk in divs) && !(grade in divs)) return 'field access: grade not allowed';
            var bunkList = divs[gk] || divs[grade];
            if (Array.isArray(bunkList) && bunkList.length > 0
                && bunkList.map(String).indexOf(String(bunk)) === -1) return 'field access: bunk not in allowed list';
        }

        // Exclusive field preference — reserved for specific grades only.
        if (fld.preferences && fld.preferences.enabled && fld.preferences.exclusive
            && Array.isArray(fld.preferences.list) && fld.preferences.list.length > 0
            && fld.preferences.list.indexOf(grade) === -1) {
            return 'field preference: exclusive to other divisions';
        }

        // Grade-scoped field time rules (setup-level + daily overrides REPLACE).
        var rules = (fld && Array.isArray(fld.timeRules)) ? fld.timeRules.slice() : [];
        try {
            var apRules = window.activityProperties && window.activityProperties[fieldName] && window.activityProperties[fieldName].timeRules;
            if (Array.isArray(apRules) && apRules.length > 0) {
                rules = apRules.slice();
            } else {
                var dd2 = window.loadCurrentDailyData && window.loadCurrentDailyData();
                var ddRules = dd2 && dd2.dailyFieldAvailability && dd2.dailyFieldAvailability[fieldName];
                if (Array.isArray(ddRules) && ddRules.length > 0) {
                    rules = ddRules.slice();
                } else {
                    var dk2 = window.currentScheduleDate || '';
                    if (dk2) {
                        var stored2 = localStorage.getItem('campResourceOverrides_' + dk2);
                        if (stored2) {
                            var p2 = JSON.parse(stored2);
                            var lsRules = p2 && p2.dailyFieldAvailability && p2.dailyFieldAvailability[fieldName];
                            if (Array.isArray(lsRules) && lsRules.length > 0) rules = lsRules.slice();
                        }
                    }
                }
            }
        } catch (_e) {}
        if (rules.length > 0 && startMin != null && endMin != null) {
            var myG = grade != null ? String(grade) : null;
            var hasGradeAvail = false, insideAvail = false;
            var _ptm = function (v) {
                if (v == null) return null;
                if (typeof window.parseTimeToMinutes === 'function') return window.parseTimeToMinutes(v);
                return null;
            };
            for (var i = 0; i < rules.length; i++) {
                var r = rules[i];
                var t = String(r.type || '').toLowerCase();
                var isUnavail = t === 'unavailable' || r.available === false;
                var isAvail = t === 'available' || r.available === true;
                var rs = (r.startMin != null) ? r.startMin : _ptm(r.start || r.startTime);
                var re = (r.endMin != null) ? r.endMin : _ptm(r.end || r.endTime);
                if (rs == null || re == null || (!isAvail && !isUnavail)) continue;
                var rDivs = Array.isArray(r.divisions) ? r.divisions.map(String) : [];
                if (rDivs.length > 0 && myG && rDivs.indexOf(myG) === -1) continue;
                if (isUnavail && rs < endMin && re > startMin) return 'field timeRules: overlapping Unavailable rule';
                if (isAvail) { hasGradeAvail = true; if (startMin >= rs && endMin <= re) insideAvail = true; }
            }
            if (hasGradeAvail && !insideAvail) return 'field timeRules: outside Available windows';
        }

        return null;
    }

    // Main entry. opts.validate (optional) overrides the default validator with
    // the caller's own (the auto engine can inject _validateWritePlacement to get
    // byte-for-byte parity). opts.log (optional) receives progress strings.
    function run(opts) {
        opts = opts || {};
        var log = (typeof opts.log === 'function') ? opts.log : function () {};
        var validate = (typeof opts.validate === 'function') ? opts.validate : _defaultValidate;

        var settings = _loadSettings();
        var flds = (settings.app1 && settings.app1.fields) || settings.fields || [];
        var divisions = window.divisions || {};

        var fgMap = {}, fgGroups = {}, hostsBySport = {}, capMap = {};
        flds.forEach(function (f) {
            if (!f || !f.name) return;
            (f.activities || []).forEach(function (sp) { (hostsBySport[sp] = hostsBySport[sp] || []).push(f.name); });
            capMap[f.name] = parseInt(f.sharableWith && f.sharableWith.capacity) || parseInt(f.capacity)
                || ((f.sharableWith && f.sharableWith.type === 'not_sharable') ? 1 : 2);
            if (f.fieldGroup && f.qualityRank) {
                fgMap[f.name] = { group: f.fieldGroup, rank: parseInt(f.qualityRank) || 999 };
                (fgGroups[f.fieldGroup] = fgGroups[f.fieldGroup] || []).push({ name: f.name, rank: parseInt(f.qualityRank) || 999 });
            }
        });
        if (Object.keys(fgGroups).length === 0) return { groups: 0, moved: 0, overlapSwaps: 0 }; // nothing to do
        Object.keys(fgGroups).forEach(function (gn) { fgGroups[gn].sort(function (a, b) { return a.rank - b.rank; }); });

        var sa = window.scheduleAssignments || {};
        var bunkGrade = {};
        Object.keys(divisions).forEach(function (g) {
            var bunks = (divisions[g] && divisions[g].bunks) || [];
            bunks.forEach(function (b) { bunkGrade[String(b)] = g; });
        });

        // Occupancy index: fieldName → [{s,e,bunk,act}]
        var occ = {};
        Object.keys(sa).forEach(function (b) {
            (sa[b] || []).forEach(function (s) {
                if (!s || s.continuation || !s.field || s.field === 'Free') return;
                var st = (s._startMin != null ? s._startMin : s.startMin), en = (s._endMin != null ? s._endMin : s.endMin);
                if (st == null || en == null) return;
                (occ[s.field] = occ[s.field] || []).push({ s: st, e: en, bunk: String(b), act: s._activity });
            });
        });

        function canUse(field, s, e, exclBunk, myGrade, myAct) {
            var list = occ[field] || []; var n = 0, ok = true;
            var coBunks = [];
            for (var i = 0; i < list.length; i++) {
                var iv = list[i];
                if (iv.bunk === exclBunk) continue;
                if (iv.s >= e || iv.e <= s) continue;
                n++;
                coBunks.push(iv.bunk);
                // Sharing a field requires every co-occupant be the SAME activity AND
                // same grade (a field hosts one activity at a time; same-division
                // shares by grade). Mixing activities/grades is not a valid share.
                if (bunkGrade[iv.bunk] !== myGrade || iv.act !== myAct) ok = false;
            }
            if (n === 0) return true;
            if (!(ok && n < (capMap[field] || 2))) return false;
            // sport maxPlayers combined-headcount guard.
            var sm = (window.sportMetaData || {})[myAct];
            if (sm && sm.maxPlayers) {
                var bm = window.bunkMetaData || {};
                var tot = (bm[exclBunk] && bm[exclBunk].size) || 0;
                for (var j = 0; j < coBunks.length; j++) tot += (bm[coBunks[j]] && bm[coBunks[j]].size) || 0;
                if (tot > sm.maxPlayers + 2) return false;
            }
            return true;
        }

        // Seniority from the canonical age order — oldest first → highest score →
        // processed FIRST so senior grades claim better-ranked fields.
        var senMap = {};
        try {
            var oldFirst = (typeof window.getDivisionAgeOrder === 'function')
                ? window.getDivisionAgeOrder(Object.keys(divisions || {}))
                : Object.keys(divisions || {});
            var N = oldFirst.length;
            oldFirst.forEach(function (nm, i) { senMap[nm] = N - 1 - i; });
        } catch (_eS) {}
        var sen = function (gr) { var v = senMap[gr]; return (v == null) ? -1 : v; };

        // ── PHASE A — pull to a strictly better-ranked free/shareable field ──
        var moved = 0;
        Object.keys(sa).sort(function (a, b) { return sen(bunkGrade[String(b)]) - sen(bunkGrade[String(a)]); }).forEach(function (b) {
            var bs = String(b), grade = bunkGrade[bs];
            (sa[b] || []).forEach(function (s) {
                if (!s || s.continuation || !s.field || s.field === 'Free') return;
                if (s._pairLock) return;                                  // never split a forced pair
                var cur = fgMap[s.field]; if (!cur) return;
                var sport = s._activity; if (!sport) return;
                var st = (s._startMin != null ? s._startMin : s.startMin), en = (s._endMin != null ? s._endMin : s.endMin);
                if (st == null || en == null) return;
                var members = fgGroups[cur.group];
                for (var i = 0; i < members.length; i++) {
                    var m = members[i];
                    if (m.rank >= cur.rank) break;                       // only strictly better-ranked
                    if (m.name === s.field) continue;
                    if ((hostsBySport[sport] || []).indexOf(m.name) < 0) continue;   // field must host the sport
                    if (!canUse(m.name, st, en, bs, grade, sport)) continue;          // capacity/sharing OK
                    if (validate(m.name, sport, grade, bs, st, en)) continue;          // access/time problem → skip
                    var from = s.field;
                    s.field = m.name; s._fqMoved = true;
                    var fl = occ[from];
                    if (fl) { for (var k = 0; k < fl.length; k++) { if (fl[k].bunk === bs && fl[k].s === st && fl[k].e === en) { fl.splice(k, 1); break; } } }
                    (occ[m.name] = occ[m.name] || []).push({ s: st, e: en, bunk: bs, act: sport });
                    moved++;
                    break;
                }
            });
        });

        // ── PHASE B — seniority re-pair within each (group, EXACT window) ──
        var slotMap = {};
        Object.keys(sa).forEach(function (bb) {
            (sa[bb] || []).forEach(function (s) {
                if (!s || s.continuation || !s.field || s.field === 'Free') return;
                if (s._pairLock) return;
                var fg = fgMap[s.field]; if (!fg) return;
                var st = (s._startMin != null ? s._startMin : s.startMin), en = (s._endMin != null ? s._endMin : s.endMin);
                if (st == null || en == null) return;
                var key = fg.group + '|' + st + '|' + en;
                (slotMap[key] = slotMap[key] || []).push({ s: s, field: s.field, grade: bunkGrade[String(bb)], bunk: String(bb), st: st, en: en });
            });
        });
        Object.keys(slotMap).forEach(function (key) {
            var list = slotMap[key];
            if (list.length < 2) return;
            var bySen = list.slice().sort(function (a, b) { return sen(b.grade) - sen(a.grade); });
            var fieldsByRank = list.map(function (p) { return p.field; }).sort(function (a, b) { return fgMap[a].rank - fgMap[b].rank; });
            var anyChange = false, ok = true;
            for (var i = 0; i < bySen.length; i++) {
                var tgt = fieldsByRank[i], p = bySen[i];
                if ((hostsBySport[p.s._activity] || []).indexOf(tgt) < 0) ok = false;
                if (p.s.field !== tgt) { anyChange = true; if (validate(tgt, p.s._activity, p.grade, p.bunk, p.st, p.en)) ok = false; }
            }
            // verify every resulting share's combined headcount respects maxPlayers.
            if (anyChange && ok) {
                var bm = window.bunkMetaData || {};
                var byTgt = {};
                for (var i2 = 0; i2 < bySen.length; i2++) {
                    (byTgt[fieldsByRank[i2]] = byTgt[fieldsByRank[i2]] || []).push(bySen[i2]);
                }
                Object.keys(byTgt).forEach(function (tf) {
                    var grp = byTgt[tf];
                    if (grp.length < 2) return;
                    var sm = (window.sportMetaData || {})[grp[0].s._activity];
                    if (!(sm && sm.maxPlayers)) return;
                    var tot = 0;
                    grp.forEach(function (p2) { tot += (bm[p2.bunk] && bm[p2.bunk].size) || 0; });
                    if (tot > sm.maxPlayers + 2) ok = false;
                });
            }
            if (!anyChange || !ok) return;
            for (var j = 0; j < bySen.length; j++) { bySen[j].s.field = fieldsByRank[j]; bySen[j].s._fqMoved = true; }
            moved++;
        });

        // ── PHASE C — staggered-overlap seniority swap ──
        var movedC = 0;
        try {
            var unitMap = {};
            Object.keys(sa).forEach(function (bb) {
                (sa[bb] || []).forEach(function (s) {
                    if (!s || s.continuation || !s.field || s.field === 'Free') return;
                    var fg = fgMap[s.field]; if (!fg) return;
                    var st = (s._startMin != null ? s._startMin : s.startMin), en = (s._endMin != null ? s._endMin : s.endMin);
                    if (st == null || en == null) return;
                    var gr = bunkGrade[String(bb)];
                    var key = fg.group + '|' + s.field + '|' + st + '|' + en + '|' + gr;
                    if (!unitMap[key]) unitMap[key] = { group: fg.group, field: s.field, st: st, en: en, grade: gr, blocks: [] };
                    unitMap[key].blocks.push({ s: s, bunk: String(bb) });
                });
            });
            var units = Object.keys(unitMap).map(function (k) { return unitMap[k]; });
            var occRemove = function (fname, bunk, st, en) {
                var fl = occ[fname]; if (!fl) return null;
                for (var k = 0; k < fl.length; k++) {
                    if (fl[k].bunk === bunk && fl[k].s === st && fl[k].e === en) return fl.splice(k, 1)[0];
                }
                return null;
            };
            var passC = 0, improvedC = true;
            while (improvedC && passC++ < 4) {
                improvedC = false;
                var ordered = units.slice().sort(function (a, b) { return sen(b.grade) - sen(a.grade); });
                for (var i = 0; i < ordered.length; i++) {
                    var A = ordered[i];
                    for (var j = 0; j < units.length; j++) {
                        var B = units[j];
                        if (A === B || A.group !== B.group || A.field === B.field) continue;
                        if (!(A.st < B.en && B.st < A.en)) continue;          // must overlap
                        if (sen(A.grade) <= sen(B.grade)) continue;           // A strictly senior
                        var ra = fgMap[A.field].rank, rb = fgMap[B.field].rank;
                        if (ra <= rb) continue;                                // already correctly ranked
                        var fa = A.field, fb = B.field;
                        var hostsOk = true;
                        A.blocks.forEach(function (x) { if ((hostsBySport[x.s._activity] || []).indexOf(fb) < 0) hostsOk = false; });
                        B.blocks.forEach(function (x) { if ((hostsBySport[x.s._activity] || []).indexOf(fa) < 0) hostsOk = false; });
                        if (!hostsOk) continue;
                        var removed = [], temp = [];
                        A.blocks.forEach(function (x) { var e = occRemove(fa, x.bunk, A.st, A.en); if (e) removed.push({ f: fa, e: e }); });
                        B.blocks.forEach(function (x) { var e = occRemove(fb, x.bunk, B.st, B.en); if (e) removed.push({ f: fb, e: e }); });
                        var okSwap = true;
                        for (var xa = 0; xa < A.blocks.length && okSwap; xa++) {
                            var x1 = A.blocks[xa];
                            if (!canUse(fb, A.st, A.en, x1.bunk, A.grade, x1.s._activity)) { okSwap = false; break; }
                            var te1 = { s: A.st, e: A.en, bunk: x1.bunk, act: x1.s._activity };
                            (occ[fb] = occ[fb] || []).push(te1); temp.push({ f: fb, e: te1 });
                        }
                        for (var xb = 0; xb < B.blocks.length && okSwap; xb++) {
                            var x2 = B.blocks[xb];
                            if (!canUse(fa, B.st, B.en, x2.bunk, B.grade, x2.s._activity)) { okSwap = false; break; }
                            var te2 = { s: B.st, e: B.en, bunk: x2.bunk, act: x2.s._activity };
                            (occ[fa] = occ[fa] || []).push(te2); temp.push({ f: fa, e: te2 });
                        }
                        if (okSwap) {
                            A.blocks.forEach(function (x) { x.s.field = fb; });
                            B.blocks.forEach(function (x) { x.s.field = fa; });
                            for (var xa2 = 0; xa2 < A.blocks.length && okSwap; xa2++) {
                                if (validate(fb, A.blocks[xa2].s._activity, A.grade, A.blocks[xa2].bunk, A.st, A.en)) okSwap = false;
                            }
                            for (var xb2 = 0; xb2 < B.blocks.length && okSwap; xb2++) {
                                if (validate(fa, B.blocks[xb2].s._activity, B.grade, B.blocks[xb2].bunk, B.st, B.en)) okSwap = false;
                            }
                            if (!okSwap) {
                                A.blocks.forEach(function (x) { x.s.field = fa; });
                                B.blocks.forEach(function (x) { x.s.field = fb; });
                            }
                        }
                        if (okSwap) {
                            A.blocks.forEach(function (x) { x.s._fqMoved = true; });
                            B.blocks.forEach(function (x) { x.s._fqMoved = true; });
                            A.field = fb; B.field = fa;
                            movedC++; improvedC = true;
                        } else {
                            temp.forEach(function (t) { var fl = occ[t.f] || []; var ix = fl.indexOf(t.e); if (ix >= 0) fl.splice(ix, 1); });
                            removed.forEach(function (r) { (occ[r.f] = occ[r.f] || []).push(r.e); });
                        }
                    }
                }
            }
        } catch (_eC) { try { console.warn('[FQ-REOPT C] ' + (_eC && _eC.message)); } catch (_e3) {} }

        // Continuation sync: a multi-period block stores its field on EVERY slot
        // (lead + continuations). The phases above move only the lead slot, so
        // propagate any moved lead's new field to its trailing continuation slots
        // — otherwise a spanned block would split across two fields.
        Object.keys(sa).forEach(function (b) {
            var arr = sa[b]; if (!Array.isArray(arr)) return;
            var lead = null;
            for (var i = 0; i < arr.length; i++) {
                var s = arr[i];
                if (!s) { lead = null; continue; }
                if (s.continuation) {
                    if (lead && lead._fqMoved && s.field && s.field !== 'Free') s.field = lead.field;
                } else {
                    lead = s;
                }
            }
        });

        try { console.log('[FQ-REOPT] ran: groups=' + Object.keys(fgGroups).length + ', moved=' + moved + ', overlapSwaps=' + movedC); } catch (_eL) {}
        if (moved > 0 || movedC > 0) log('  🏟️ Field-quality re-opt: ' + moved + ' move(s), ' + movedC + ' staggered-overlap seniority swap(s).');
        return { groups: Object.keys(fgGroups).length, moved: moved, overlapSwaps: movedC };
    }

    window.FieldQualityReopt = { run: run };
    try { console.log('[FieldQualityReopt] loaded'); } catch (_e) {}
})();
