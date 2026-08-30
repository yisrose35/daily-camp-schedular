// =============================================================================
// campistry_live_schedule_reader.js — read-only "today's schedule" loader for
// Campistry Live.
//
// Flow's camper_locator.js reads the schedule off `window.scheduleAssignments`
// / `window.divisionTimes` / `window.leagueAssignments`, all populated by
// Flow-only hydration scripts (schedule_orchestrator.js, division_times_
// system.js, app1.js) that Live never loads. There's no existing "get today's
// saved schedule, read-only" API outside Flow, so this is a small, Live-scoped
// one: query the same `daily_schedules` Supabase table Flow's own
// supabase_schedules.js reads, merge any multiple per-scheduler rows for the
// date, and hand back a plain object — never touching `window.*` globals,
// since that's Flow's convention for a live editor, not a read-only viewer.
//
// This intentionally does NOT replicate supabase_schedules.js's per-division
// write-timestamp precedence (that machinery exists to keep concurrent SAVES
// from clobbering each other); a reader only needs last-writer-wins.
// =============================================================================
(function () {
    'use strict';

    function deserializeUnifiedTimes(times) {
        if (!times || !Array.isArray(times)) return [];
        return times.map(function (t) {
            var s = new Date(t.start), e = new Date(t.end);
            return {
                start: s, end: e,
                startMin: t.startMin != null ? t.startMin : (s.getHours() * 60 + s.getMinutes()),
                endMin: t.endMin != null ? t.endMin : (e.getHours() * 60 + e.getMinutes()),
                label: t.label || ''
            };
        });
    }

    function deserializeDivisionTimes(serialized) {
        if (!serialized) return {};
        var out = {};
        Object.keys(serialized).forEach(function (divName) {
            var data = serialized[divName];
            var slotsArr = Array.isArray(data) ? data : ((data && data._slots) || []);
            out[divName] = slotsArr.map(function (slot) {
                return Object.assign({}, slot, {
                    start: new Date(slot.start), end: new Date(slot.end),
                    startMin: slot.startMin, endMin: slot.endMin,
                    duration: slot.duration || (slot.endMin - slot.startMin)
                });
            });
        });
        return out;
    }

    function todayKey() {
        var d = new Date(); d.setHours(12, 0, 0, 0);
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    // { bunkName: schedulingDivisionName }, sourced from the camp structure
    // passed in by the caller (Live's own getStructure()) — not
    // window.divisions, which is Flow-only state.
    //
    // Maps to the GRADE name, not the top-level structure key. Confirmed via
    // access_control.js's own subdivision-expansion comment ("window.divisions
    // is keyed by grade names... each grade entry has a parentDivision
    // property linking back") and by inspecting a real camp's data directly:
    // campStructure's top level ("Nanitos", "Neranina") is an organizational
    // grouping, but daily_schedules.schedule_data.divisionTimes — the actual
    // per-division period list the scheduler writes — is keyed by the GRADE
    // names underneath it ("Prop", "Trios", "Duetos", ...). Mapping bunks to
    // the top-level key here meant every divisionTimes[...] lookup elsewhere
    // in this file (and resolveCamperAt/performSearch, which read this map
    // via CampistryLiveLocator.bunkToDivision()) silently found nothing for
    // any camp using this two-level structure — the schedule grid showed
    // "No schedule times have been set up" and the search box showed
    // "no-schedule" for every camper, even with a real schedule generated.
    function bunkToDivisionMap(structure) {
        var m = {};
        Object.keys(structure || {}).forEach(function (divName) {
            var divData = structure[divName] || {};
            Object.keys(divData.grades || {}).forEach(function (gradeName) {
                (((divData.grades || {})[gradeName] || {}).bunks || []).forEach(function (b) {
                    m[String(b)] = gradeName;
                });
            });
        });
        return m;
    }

    function mergeRecords(records, structure) {
        var assignments = {}, leagues = {}, divisionTimes = {}, unifiedTimes = [];
        var bunkToDiv = bunkToDivisionMap(structure);

        records = records.slice().sort(function (a, b) {
            var ta = a.updated_at || a.created_at || '', tb = b.updated_at || b.created_at || '';
            return ta < tb ? -1 : ta > tb ? 1 : 0;
        });

        records.forEach(function (record) {
            var data = record.schedule_data || {};
            if (data.scheduleAssignments) {
                Object.keys(data.scheduleAssignments).forEach(function (bunkId) {
                    assignments[bunkId] = data.scheduleAssignments[bunkId];
                });
            }
            if (data.leagueAssignments) {
                Object.keys(data.leagueAssignments).forEach(function (div) {
                    leagues[div] = data.leagueAssignments[div];
                });
            }
            if (data.unifiedTimes && Array.isArray(data.unifiedTimes) && data.unifiedTimes.length) {
                unifiedTimes = data.unifiedTimes;
            } else if (record.unified_times && Array.isArray(record.unified_times) && record.unified_times.length) {
                unifiedTimes = record.unified_times;
            }
            if (data.divisionTimes) {
                Object.keys(data.divisionTimes).forEach(function (divName) {
                    var slots = data.divisionTimes[divName];
                    var existing = divisionTimes[divName];
                    if (!existing || (slots && slots.length > existing.length)) {
                        divisionTimes[divName] = slots;
                    }
                });
            }
        });

        // Drop any bunk no longer in the current camp structure (deleted or
        // renamed since the schedule was saved) — same intent as supabase_
        // schedules.js's structure-aware prune, simplified for a read-only view.
        var validBunks = Object.keys(bunkToDiv);
        if (validBunks.length) {
            var validSet = {};
            validBunks.forEach(function (b) { validSet[b] = true; });
            Object.keys(assignments).forEach(function (b) { if (!validSet[b]) delete assignments[b]; });
        }

        return {
            scheduleAssignments: assignments,
            leagueAssignments: leagues,
            unifiedTimes: deserializeUnifiedTimes(unifiedTimes),
            divisionTimes: deserializeDivisionTimes(divisionTimes),
            bunkToDivision: bunkToDiv
        };
    }

    function loadForDate(dateKey, structure) {
        var d = window.CampistryDB;
        var client = d && d.getClient ? d.getClient() : null;
        var campId = d && d.getCampId ? d.getCampId() : null;
        if (!client || !campId) return Promise.resolve(mergeRecords([], structure));
        return client.from('daily_schedules').select('*').eq('camp_id', campId).eq('date_key', dateKey)
            .then(function (res) {
                if (res.error) { console.warn('[LiveScheduleReader] load failed:', res.error.message); return mergeRecords([], structure); }
                return mergeRecords(res.data || [], structure);
            }, function () { return mergeRecords([], structure); });
    }

    function loadToday(structure) {
        return loadForDate(todayKey(), structure);
    }

    window.LiveScheduleReader = { loadToday: loadToday, loadForDate: loadForDate, todayKey: todayKey };
})();
