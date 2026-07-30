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
//   Phase P  (preference pull, `pullToPreferred`) move each block onto the field
//            its GRADE prefers for that activity when that field is usable —
//            rules.js "Field Preferences". Runs first and independently of field
//            groups; every phase below refuses to undo it.
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
// and idempotent. Phases A-D no-op when no field groups are configured; Phase P
// no-ops when no field preference is configured.
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

    // ★ rules.js FIELD PREFERENCES BY GRADE (Rules tab): a per-grade field ranking
    //   the user set by hand. Quality rank orders fields for the whole camp; this
    //   orders them for ONE grade, so it wins here — every phase below refuses a
    //   move/swap that would put a grade on a field it prefers less. Signed: lower
    //   is more preferred (negative = the grade's top choice, 0 = no opinion).
    function _prefBias(grade, fieldName, activityName) {
        if (!grade || !fieldName) return 0;
        return window.SchedulerCoreUtils?.getFieldPreferenceBias?.(grade, fieldName, activityName, 1) || 0;
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

        // Config-level shut-off: field toggled UNAVAILABLE in Facilities
        // (available:false). Defense-in-depth alongside the group-build filter.
        if (fld && fld.available === false) return 'field unavailable (Facilities toggle off)';

        // Daily per-field sport disable (Resources panel → per-date overrides).
        if (activityName) {
            var dailySports = null;
            try {
                var dd = window.loadCurrentDailyData && window.loadCurrentDailyData();
                if (dd && dd.dailyDisabledSportsByField && dd.dailyDisabledSportsByField[fieldName]) {
                    dailySports = dd.dailyDisabledSportsByField[fieldName];
                } else {
                    var dk = window._activeGenDate || window.currentScheduleDate || '';
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

        // Global field locks — leagues / pinned events / electives reserve fields
        // without putting blocks in scheduleAssignments, so the occupancy ledger
        // can't see them. Ask the lock registry directly (skip if unavailable).
        try {
            var GFL = window.GlobalFieldLocks;
            if (GFL && typeof GFL.isFieldLockedByTime === 'function' && startMin != null && endMin != null) {
                var lk = GFL.isFieldLockedByTime(fieldName, startMin, endMin, grade);
                if (lk) return 'globally locked (' + (lk.lockedBy || lk.reason || 'lock') + ')';
            }
        } catch (_eL) {}

        // Skeleton field reservations — a pinned event / league reserves a facility
        // for a window via window.fieldReservations, WITHOUT a GlobalFieldLock or a
        // scheduleAssignments block (e.g. a "Max Leagues" pin on Slam Plex 1 @740-810).
        // canBlockFit (scheduler_core_utils.js:835) and the STEP 7.9 evict sweep both
        // reject a placement here. Without this check FQ-reopt can pull a placement ONTO
        // a reserved court, which STEP 7.9 then demotes to Free — the exact "why are we
        // getting Frees" case. Mirrors canBlockFit exactly (same isFieldReserved call).
        try {
            var _resvFQ = window.fieldReservations;
            var _U = window.SchedulerCoreUtils;
            if (_resvFQ && _U && typeof _U.isFieldReserved === 'function' && startMin != null && endMin != null) {
                var _rv = _U.isFieldReserved(fieldName, startMin, endMin, _resvFQ);
                if (_rv) return 'reserved by pinned "' + (_rv.event || 'event') + '"';
            }
        } catch (_eR) {}

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
                    var dk2 = window._activeGenDate || window.currentScheduleDate || '';
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

    // A field move rewrites entry.field but NOT the display label, and a spanned
    // block keeps its field on every continuation slot. Sync both for every entry
    // a pass moved. Shared by run() and pullToPreferred() (either can be the only
    // pass that moved anything).
    function _syncMovedLabels(sa) {
        var _fqSyncLoc = function (s, fld) {
            if (!s || !fld) return;
            if (typeof s._location === 'string' && s._location && s._location !== fld) s._location = fld;
            if (typeof s.location === 'string' && s.location && s.location !== fld) s.location = fld;
        };
        Object.keys(sa || {}).forEach(function (b) {
            var arr = sa[b]; if (!Array.isArray(arr)) return;
            var lead = null;
            for (var i = 0; i < arr.length; i++) {
                var s = arr[i];
                if (!s) { lead = null; continue; }
                if (s.continuation) {
                    if (lead && lead._fqMoved && s.field && s.field !== 'Free') { s.field = lead.field; _fqSyncLoc(s, lead.field); }
                } else {
                    lead = s;
                    if (s._fqMoved && s.field && s.field !== 'Free') _fqSyncLoc(s, s.field);
                }
            }
        });
    }

    // =========================================================================
    // PREFERENCE PULL — rules.js "Field Preferences" (per-grade field ranking)
    // =========================================================================
    // The scorers already lean toward a grade's preferred field while placing, but
    // a block placed EARLY can land on the runner-up court simply because the
    // favorite was still busy at the time — and nothing later brings it back. This
    // pass closes that gap: for every placement whose grade would rather be on a
    // different field for that activity, move it there when the field hosts the
    // activity, is free (or same-grade/same-activity shareable within capacity)
    // and the move validates. Strongest improvement first, so a grade whose FIRST
    // choice a field is claims it ahead of a grade that merely ranks it second.
    //
    // Independent of Field Quality Groups — it runs even when no group is
    // configured, and it runs BEFORE the quality phases so their own preference
    // guards can only make moves that don't undo it.
    // Field-only: never changes an activity or a time, so rotation/frequency state
    // is untouched. Skips league / post-edit / pinned / pair-locked blocks.
    function pullToPreferred(opts) {
        opts = opts || {};
        var log = (typeof opts.log === 'function') ? opts.log : function () {};
        var validate = (typeof opts.validate === 'function') ? opts.validate : _defaultValidate;

        var U = window.SchedulerCoreUtils;
        if (!U || typeof U.getFieldPreferenceBias !== 'function') return 0;
        var settings = _loadSettings();
        var prefRules = (settings.schedulingRules && settings.schedulingRules.fieldPreferences) || [];
        if (!Array.isArray(prefRules) || !prefRules.length) return 0;   // nothing configured → no-op

        var flds = (settings.app1 && settings.app1.fields) || settings.fields || [];
        var hostsBySport = {}, capMap = {}, rankOf = {};
        flds.forEach(function (f) {
            if (!f || !f.name) return;
            if (f.available === false) return;                          // Facilities toggle off
            (f.activities || []).forEach(function (sp) { (hostsBySport[sp] = hostsBySport[sp] || []).push(f.name); });
            capMap[f.name] = parseInt(f.sharableWith && f.sharableWith.capacity) || parseInt(f.capacity)
                || ((f.sharableWith && f.sharableWith.type === 'not_sharable') ? 1 : 2);
            rankOf[f.name] = parseInt(f.qualityRank) || 999;
        });

        var sa = window.scheduleAssignments || {};
        var divisions = window.divisions || {};
        var bunkGrade = {};
        Object.keys(divisions).forEach(function (g) {
            ((divisions[g] && divisions[g].bunks) || []).forEach(function (b) { bunkGrade[String(b)] = g; });
        });

        var occ = {};
        Object.keys(sa).forEach(function (b) {
            (sa[b] || []).forEach(function (s) {
                if (!s || s.continuation || !s.field || s.field === 'Free') return;
                var st = (s._startMin != null ? s._startMin : s.startMin), en = (s._endMin != null ? s._endMin : s.endMin);
                if (st == null || en == null) return;
                (occ[s.field] = occ[s.field] || []).push({ s: st, e: en, bunk: String(b), act: s._activity });
            });
        });
        // Same admission rule as the quality phases: empty field, or a same-grade
        // same-activity share still under capacity (a field hosts one activity for
        // one grade at a time), plus the sport's combined-headcount ceiling.
        function canUse(field, s, e, exclBunk, myGrade, myAct) {
            var list = occ[field] || [], n = 0, ok = true, coBunks = [];
            for (var i = 0; i < list.length; i++) {
                var iv = list[i];
                if (iv.bunk === exclBunk) continue;
                if (iv.s >= e || iv.e <= s) continue;
                n++; coBunks.push(iv.bunk);
                if (bunkGrade[iv.bunk] !== myGrade || iv.act !== myAct) ok = false;
            }
            if (n === 0) return true;
            if (!(ok && n < (capMap[field] || 2))) return false;
            var sm = (window.getSportMetaData?.() || window.sportMetaData || {})[myAct];
            if (sm && sm.maxPlayers) {
                var bm = window.getBunkMetaData?.() || window.bunkMetaData || {};
                var tot = (bm[exclBunk] && bm[exclBunk].size) || 0;
                for (var j = 0; j < coBunks.length; j++) tot += (bm[coBunks[j]] && bm[coBunks[j]].size) || 0;
                if (tot > sm.maxPlayers + 2) return false;
            }
            return true;
        }
        var bias = function (grade, field, act) {
            if (!grade || !field) return 0;
            return U.getFieldPreferenceBias(grade, field, act, 1) || 0;
        };

        var moved = 0;
        for (var round = 0; round < 3; round++) {                       // a freed field can enable another pull
            // Collect every placement's best improving target, then apply the
            // biggest improvements first so the strongest preference wins the field.
            var wants = [];
            Object.keys(sa).forEach(function (b) {
                var bs = String(b), grade = bunkGrade[bs];
                if (!grade) return;
                (sa[b] || []).forEach(function (s) {
                    if (!s || s.continuation || !s.field || s.field === 'Free') return;
                    if (s._pairLock || s._league || s._postEdit || s._pinned) return;   // locked placements stay put
                    var act = s._activity; if (!act) return;
                    var hosts = hostsBySport[act]; if (!hosts || hosts.length < 2) return;
                    var st = (s._startMin != null ? s._startMin : s.startMin), en = (s._endMin != null ? s._endMin : s.endMin);
                    if (st == null || en == null) return;
                    var curB = bias(grade, s.field, act);
                    var best = null, bestB = curB;
                    for (var i = 0; i < hosts.length; i++) {
                        var cand = hosts[i];
                        if (cand === s.field) continue;
                        var cb = bias(grade, cand, act);
                        if (cb >= bestB) continue;                       // not an improvement
                        // Tie-break equal preference by camp-wide field quality.
                        if (best && cb === bestB && (rankOf[cand] || 999) >= (rankOf[best] || 999)) continue;
                        best = cand; bestB = cb;
                    }
                    if (best) wants.push({ s: s, bunk: bs, grade: grade, act: act, st: st, en: en, to: best, gain: curB - bestB });
                });
            });
            if (!wants.length) break;
            wants.sort(function (a, b) { return b.gain - a.gain; });

            var movedThisRound = 0;
            for (var w = 0; w < wants.length; w++) {
                var m = wants[w];
                // Re-check against the live ledger — an earlier move this round may
                // have taken the field, or made this one unnecessary.
                if (bias(m.grade, m.to, m.act) >= bias(m.grade, m.s.field, m.act)) continue;
                if (!canUse(m.to, m.st, m.en, m.bunk, m.grade, m.act)) continue;
                if (validate(m.to, m.act, m.grade, m.bunk, m.st, m.en)) continue;
                var from = m.s.field;
                m.s.field = m.to; m.s._fqMoved = true; m.s._prefMoved = true;
                var fl = occ[from];
                if (fl) { for (var k = 0; k < fl.length; k++) { if (fl[k].bunk === m.bunk && fl[k].s === m.st && fl[k].e === m.en) { fl.splice(k, 1); break; } } }
                (occ[m.to] = occ[m.to] || []).push({ s: m.st, e: m.en, bunk: m.bunk, act: m.act });
                moved++; movedThisRound++;
            }
            if (!movedThisRound) break;
        }

        if (moved > 0) {
            _syncMovedLabels(sa);
            try { console.log('[FQ-REOPT] preference pull: ' + moved + ' block(s) moved to a grade-preferred field'); } catch (_e) {}
            log('  ⭐ Field preferences: ' + moved + ' block(s) pulled to the grade\'s preferred field.');
        }
        return moved;
    }

    // Main entry. opts.validate (optional) overrides the default validator with
    // the caller's own (the auto engine can inject _validateWritePlacement to get
    // byte-for-byte parity). opts.log (optional) receives progress strings.
    function run(opts) {
        opts = opts || {};
        var log = (typeof opts.log === 'function') ? opts.log : function () {};
        var validate = (typeof opts.validate === 'function') ? opts.validate : _defaultValidate;

        // ★ Per-grade field preferences first: they outrank camp-wide quality, and
        //   the quality phases below all carry a guard that refuses to undo them.
        //   Runs even when no field group is configured (hence before the guard).
        var prefMoves = 0;
        try { prefMoves = pullToPreferred(opts); }
        catch (_eP) { try { console.warn('[FQ-REOPT PREF] ' + (_eP && _eP.message)); } catch (_e0) {} }

        var settings = _loadSettings();
        var flds = (settings.app1 && settings.app1.fields) || settings.fields || [];
        var divisions = window.divisions || {};

        var fgMap = {}, fgGroups = {}, hostsBySport = {}, capMap = {};
        flds.forEach(function (f) {
            if (!f || !f.name) return;
            // ★ Config-level shut-off: a field toggled UNAVAILABLE in Facilities
            //   (available:false) must never be a field-quality relocation target.
            //   Excluding it from hostsBySport / fgGroups here keeps every phase
            //   (A pull, B re-pair, C swap) from moving a placement onto it.
            if (f.available === false) return;
            (f.activities || []).forEach(function (sp) { (hostsBySport[sp] = hostsBySport[sp] || []).push(f.name); });
            capMap[f.name] = parseInt(f.sharableWith && f.sharableWith.capacity) || parseInt(f.capacity)
                || ((f.sharableWith && f.sharableWith.type === 'not_sharable') ? 1 : 2);
            if (f.fieldGroup && f.qualityRank) {
                fgMap[f.name] = { group: f.fieldGroup, rank: parseInt(f.qualityRank) || 999 };
                (fgGroups[f.fieldGroup] = fgGroups[f.fieldGroup] || []).push({ name: f.name, rank: parseInt(f.qualityRank) || 999 });
            }
        });
        // No quality groups → the preference pull above was the whole pass.
        if (Object.keys(fgGroups).length === 0) return { groups: 0, moved: 0, overlapSwaps: 0, prefMoves: prefMoves };
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
            // ★ v3.2 fix: window.sportMetaData is hydrated only by AUTO runs
            //   (scheduler_core_auto FN-38) — in MANUAL mode it is usually
            //   undefined and this guard silently no-oped. Read through the
            //   getter first (same source total_solver uses) so the cap holds
            //   in both builders.
            var sm = (window.getSportMetaData?.() || window.sportMetaData || {})[myAct];
            if (sm && sm.maxPlayers) {
                var bm = window.getBunkMetaData?.() || window.bunkMetaData || {};
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
                    // ★ rules.js FIELD PREFERENCES BY GRADE: quality rank is the camp-wide
                    //   "which field is nicer" order; a per-grade preference is the user
                    //   overriding it for this grade ("2nd Grade plays on Court 2"). Never
                    //   pull a bunk onto a field its grade likes LESS than the current one.
                    if (_prefBias(grade, m.name, sport) > _prefBias(grade, s.field, sport)) continue;
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
                var bm = window.getBunkMetaData?.() || window.bunkMetaData || {};
                var byTgt = {};
                for (var i2 = 0; i2 < bySen.length; i2++) {
                    (byTgt[fieldsByRank[i2]] = byTgt[fieldsByRank[i2]] || []).push(bySen[i2]);
                }
                Object.keys(byTgt).forEach(function (tf) {
                    var grp = byTgt[tf];
                    if (grp.length < 2) return;
                    // ★ A field hosts ONE grade at a time (same_division sharing). The
                    //   bijection above can split a same-grade share and land two
                    //   DIFFERENT grades on one field — a cross-division conflict the
                    //   validator later has to repair by dropping a placement. Reject
                    //   any re-pair that would co-locate different grades.
                    for (var gck = 1; gck < grp.length; gck++) { if (grp[gck].grade !== grp[0].grade) { ok = false; return; } }
                    // ★ v3.2 fix: read through the getter — window.sportMetaData is
                    //   only hydrated by AUTO runs (see guard above).
                    var sm = (window.getSportMetaData?.() || window.sportMetaData || {})[grp[0].s._activity];
                    if (!(sm && sm.maxPlayers)) return;
                    var tot = 0;
                    grp.forEach(function (p2) { tot += (bm[p2.bunk] && bm[p2.bunk].size) || 0; });
                    if (tot > sm.maxPlayers + 2) ok = false;
                });
            }
            if (!anyChange || !ok) return;
            // ★ Per-grade field preferences outrank camp-wide quality: reject a
            //   re-pair that leaves the grades collectively on less-preferred fields.
            var _prefBefore = 0, _prefAfter = 0;
            for (var pb = 0; pb < bySen.length; pb++) {
                _prefBefore += _prefBias(bySen[pb].grade, bySen[pb].s.field, bySen[pb].s._activity);
                _prefAfter += _prefBias(bySen[pb].grade, fieldsByRank[pb], bySen[pb].s._activity);
            }
            if (_prefAfter > _prefBefore) return;
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
                        // ★ Per-grade field preferences outrank camp-wide quality —
                        //   don't swap two units onto fields their grades like less.
                        var _pfBefore = 0, _pfAfter = 0;
                        A.blocks.forEach(function (x) { _pfBefore += _prefBias(A.grade, fa, x.s._activity); _pfAfter += _prefBias(A.grade, fb, x.s._activity); });
                        B.blocks.forEach(function (x) { _pfBefore += _prefBias(B.grade, fb, x.s._activity); _pfAfter += _prefBias(B.grade, fa, x.s._activity); });
                        if (_pfAfter > _pfBefore) continue;
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

        // ── PHASE D — whole-field group swap. Phases A-C move/swap atomic units
        //   keyed by an exact (or overlapping) window, so they CANNOT fix the
        //   common cross-division case where a senior block (e.g. one 75-min
        //   period 740-815) spans a boundary at which a better field hands off
        //   between two SEQUENTIAL junior occupants (e.g. 740-805 then 805-870):
        //   every candidate move collides with the second junior, so nothing
        //   moves. This phase exchanges the ENTIRE block set of two same-group
        //   fields at once (all of field X ↔ all of field Y) when the WORSE-
        //   ranked field currently holds a more-senior grade than the better-
        //   ranked one. Moving every block wholesale preserves each field's
        //   internal time structure, same-grade shares and locked pairs intact,
        //   so we only re-check host + access/time per block and that each side's
        //   peak concurrency still fits the destination field's capacity.
        var movedD = 0;
        try {
            var blocksByField = {};
            Object.keys(sa).forEach(function (bb) {
                (sa[bb] || []).forEach(function (s) {
                    if (!s || s.continuation || !s.field || s.field === 'Free') return;
                    if (!fgMap[s.field]) return;
                    var st = (s._startMin != null ? s._startMin : s.startMin), en = (s._endMin != null ? s._endMin : s.endMin);
                    if (st == null || en == null) return;
                    (blocksByField[s.field] = blocksByField[s.field] || []).push({ s: s, bunk: String(bb), st: st, en: en, act: s._activity, grade: bunkGrade[String(bb)] });
                });
            });
            var maxConcurrent = function (blocks) {
                var pts = [];
                blocks.forEach(function (b) { pts.push([b.st, 1]); pts.push([b.en, -1]); });
                pts.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; }); // end (-1) before start (+1) at a shared boundary
                var cur = 0, mx = 0;
                pts.forEach(function (p) { cur += p[1]; if (cur > mx) mx = cur; });
                return mx;
            };
            var maxSenOf = function (field) {
                var bl = blocksByField[field] || []; var m = -Infinity;
                bl.forEach(function (x) { var v = sen(x.grade); if (v > m) m = v; });
                return m;
            };
            var canSwap = function (fa, fb) {
                var ba = blocksByField[fa] || [], bb2 = blocksByField[fb] || [];
                for (var i = 0; i < ba.length; i++) {
                    if ((hostsBySport[ba[i].act] || []).indexOf(fb) < 0) return false;
                    if (validate(fb, ba[i].act, ba[i].grade, ba[i].bunk, ba[i].st, ba[i].en)) return false;
                }
                for (var j = 0; j < bb2.length; j++) {
                    if ((hostsBySport[bb2[j].act] || []).indexOf(fa) < 0) return false;
                    if (validate(fa, bb2[j].act, bb2[j].grade, bb2[j].bunk, bb2[j].st, bb2[j].en)) return false;
                }
                if (maxConcurrent(ba) > (capMap[fb] || 2)) return false;   // peak on fa must fit fb
                if (maxConcurrent(bb2) > (capMap[fa] || 2)) return false;  // peak on fb must fit fa
                // ★ Per-grade field preferences outrank camp-wide quality — never
                //   swap the two field rosters onto less-preferred fields overall.
                var _pBefore = 0, _pAfter = 0;
                ba.forEach(function (x) { _pBefore += _prefBias(x.grade, fa, x.act); _pAfter += _prefBias(x.grade, fb, x.act); });
                bb2.forEach(function (x) { _pBefore += _prefBias(x.grade, fb, x.act); _pAfter += _prefBias(x.grade, fa, x.act); });
                if (_pAfter > _pBefore) return false;
                return true;
            };
            var doSwap = function (fa, fb) {
                var ba = blocksByField[fa] || [], bb2 = blocksByField[fb] || [];
                ba.forEach(function (x) { x.s.field = fb; x.s._fqMoved = true; });
                bb2.forEach(function (x) { x.s.field = fa; x.s._fqMoved = true; });
                blocksByField[fa] = bb2; blocksByField[fb] = ba;
            };
            Object.keys(fgGroups).forEach(function (gn) {
                var fieldsAsc = fgGroups[gn].map(function (m) { return m.name; })
                    .sort(function (a, b) { return fgMap[a].rank - fgMap[b].rank; }); // best (rank 1) first
                var passes = 0, improved = true;
                while (improved && passes++ < fieldsAsc.length + 2) {
                    improved = false;
                    for (var i = 0; i < fieldsAsc.length; i++) {
                        for (var j = i + 1; j < fieldsAsc.length; j++) {
                            var fi = fieldsAsc[i], fj = fieldsAsc[j];      // fi strictly better-ranked than fj
                            var bi = blocksByField[fi] || [], bj = blocksByField[fj] || [];
                            if (!bi.length || !bj.length) continue;        // only fix genuine inversions
                            if (maxSenOf(fj) <= maxSenOf(fi)) continue;    // worse field must hold a MORE senior grade
                            if (!canSwap(fi, fj)) continue;
                            doSwap(fi, fj);
                            movedD++; improved = true;
                        }
                    }
                }
            });
        } catch (_eD) { try { console.warn('[FQ-REOPT D] ' + (_eD && _eD.message)); } catch (_e4) {} }

        // A field move rewrites entry.field but NOT the display label. Readers that
        // prefer _location / location (resolveEntryLocation, print, camper locator)
        // would then show the PRE-move field — which surfaces as "two bunks on
        // different fields" when a moved bunk is really sharing its new field with
        // another. Sync labels + spanned-block continuations to every moved field.
        // (FQ-reopt only moves real sport fields, never a special whose field holds
        // the activity name, so this leaves the special room convention alone.)
        _syncMovedLabels(sa);

        try { console.log('[FQ-REOPT] ran: groups=' + Object.keys(fgGroups).length + ', prefMoves=' + prefMoves + ', moved=' + moved + ', overlapSwaps=' + movedC + ', fieldSwaps=' + movedD); } catch (_eL) {}
        if (moved > 0 || movedC > 0 || movedD > 0) log('  🏟️ Field-quality re-opt: ' + moved + ' move(s), ' + movedC + ' staggered-overlap swap(s), ' + movedD + ' whole-field swap(s).');
        return { groups: Object.keys(fgGroups).length, moved: moved, overlapSwaps: movedC, fieldSwaps: movedD, prefMoves: prefMoves };
    }

    window.FieldQualityReopt = { run: run, pullToPreferred: pullToPreferred };
    try { console.log('[FieldQualityReopt] loaded'); } catch (_e) {}
})();
