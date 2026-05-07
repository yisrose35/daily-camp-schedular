// =========================================================================
// rotation_cloud.js — Cloud-synced rotation count tracking via Supabase
//
// Table: rotation_counts (camp_id, date_key, bunk, activity, count)
// One row per bunk-activity-date. Supports regeneration (delete+reinsert).
// =========================================================================
(function() {
    'use strict';

    var TABLE = 'rotation_counts';
    var _cache = null;
    var _cacheTime = 0;
    var CACHE_TTL = 30000;

    function getClient() {
        return window.CampistryDB?.getClient?.();
    }

    function getCampId() {
        return window.CampistryDB?.getCampId?.();
    }

    function getValidActivityNames() {
        if (window.SchedulerCoreUtils?.getValidActivityNames) {
            return window.SchedulerCoreUtils.getValidActivityNames();
        }
        var g = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
        var app1 = g.app1 || {};
        var valid = new Set();
        (app1.fields || []).forEach(function(f) {
            (f.activities || []).forEach(function(a) { valid.add(a); });
        });
        (app1.specialActivities || []).forEach(function(s) {
            if (s.name) valid.add(s.name);
        });
        return valid;
    }

    // =====================================================================
    // SAVE: Extract counts from scheduleAssignments and upsert to cloud
    // =====================================================================
    function saveRotationCounts(dateKey, scheduleAssignments) {
        var client = getClient();
        var campId = getCampId();
        if (!client || !campId || !dateKey) {
            console.warn('[RotationCloud] Missing client/campId/dateKey — skipping save');
            return Promise.resolve(false);
        }

        var sched = scheduleAssignments || {};
        var validActivities = getValidActivityNames();
        var counts = {};

        Object.keys(sched).forEach(function(bunk) {
            (sched[bunk] || []).forEach(function(entry) {
                if (!entry || entry.continuation || entry._isTransition) return;
                var actName = entry._activity || entry.sport || '';
                if (!actName) return;
                if (!validActivities.has(actName) && entry.sport && validActivities.has(entry.sport)) {
                    actName = entry.sport;
                }
                var actLower = actName.toLowerCase();
                if (actLower === 'free' || actLower.includes('transition')) return;
                if (!validActivities.has(actName)) return;

                var key = bunk + '|' + actName;
                counts[key] = (counts[key] || 0) + 1;
            });
        });

        var rows = [];
        Object.keys(counts).forEach(function(key) {
            var parts = key.split('|');
            rows.push({
                camp_id: campId,
                date_key: dateKey,
                bunk: parts[0],
                activity: parts[1],
                count: counts[key],
                updated_at: new Date().toISOString()
            });
        });

        if (rows.length === 0) {
            console.log('[RotationCloud] No valid activities to save for', dateKey);
            return Promise.resolve(true);
        }

        // ★ Use upsert with onConflict on the composite PK so concurrent
        // saves (or a regen-then-save race) don't fail with 409.
        // The previous delete-then-insert sequence was racing with itself
        // when two RotationCloud.save calls overlapped during one generation.
        return client
            .from(TABLE)
            .upsert(rows, { onConflict: 'camp_id,date_key,bunk,activity' })
            .then(function(result) {
                if (result.error) {
                    console.error('[RotationCloud] Upsert error:', result.error.message);
                    return false;
                }
                console.log('[RotationCloud] Saved', rows.length, 'rotation rows for', dateKey);
                _cache = null;
                return true;
            })
            .catch(function(e) {
                console.error('[RotationCloud] Save failed:', e);
                return false;
            });
    }

    // =====================================================================
    // LOAD: Fetch all rotation counts for this camp, grouped by bunk
    // Returns: { counts: { bunk: { activity: total } }, lastDone: { bunk: { activity: dateStr } } }
    // =====================================================================
    function loadRotationCounts(forceRefresh) {
        if (!forceRefresh && _cache && (Date.now() - _cacheTime) < CACHE_TTL) {
            return Promise.resolve(_cache);
        }

        var client = getClient();
        var campId = getCampId();
        if (!client || !campId) {
            return Promise.resolve({ counts: {}, lastDone: {} });
        }

        return client
            .from(TABLE)
            .select('bunk, activity, count, date_key')
            .eq('camp_id', campId)
            .then(function(result) {
                if (result.error) {
                    console.error('[RotationCloud] Load error:', result.error.message);
                    return { counts: {}, lastDone: {} };
                }

                var counts = {};
                var lastDone = {};
                var countsByDate = {}; // ★ Per-date breakdown for smart merging
                (result.data || []).forEach(function(row) {
                    counts[row.bunk] = counts[row.bunk] || {};
                    counts[row.bunk][row.activity] = (counts[row.bunk][row.activity] || 0) + row.count;

                    lastDone[row.bunk] = lastDone[row.bunk] || {};
                    var dateStr = String(row.date_key).substring(0, 10);
                    if (!lastDone[row.bunk][row.activity] || dateStr > lastDone[row.bunk][row.activity]) {
                        lastDone[row.bunk][row.activity] = dateStr;
                    }

                    // ★ Track per-date counts so consumers can exclude/replace a specific date
                    if (!countsByDate[dateStr]) countsByDate[dateStr] = {};
                    if (!countsByDate[dateStr][row.bunk]) countsByDate[dateStr][row.bunk] = {};
                    countsByDate[dateStr][row.bunk][row.activity] =
                        (countsByDate[dateStr][row.bunk][row.activity] || 0) + row.count;
                });

                _cache = { counts: counts, lastDone: lastDone, countsByDate: countsByDate };
                _cacheTime = Date.now();
                console.log('[RotationCloud] Loaded rotation data:', (result.data || []).length, 'rows');
                return _cache;
            })
            .catch(function(e) {
                console.error('[RotationCloud] Load failed:', e);
                return { counts: {}, lastDone: {} };
            });
    }

    // =====================================================================
    // DELETE: Remove all counts for a specific date (used before regeneration)
    // =====================================================================
    function deleteRotationCounts(dateKey) {
        var client = getClient();
        var campId = getCampId();
        if (!client || !campId || !dateKey) return Promise.resolve(false);

        return client
            .from(TABLE)
            .delete()
            .eq('camp_id', campId)
            .eq('date_key', dateKey)
            .then(function(result) {
                if (result.error) {
                    console.error('[RotationCloud] Delete error:', result.error.message);
                    return false;
                }
                _cache = null;
                return true;
            })
            .catch(function(e) {
                console.error('[RotationCloud] Delete failed:', e);
                return false;
            });
    }

    // =====================================================================
    // CLEAR ALL: Remove all rotation data for this camp (used on half reset)
    // =====================================================================
    function clearAllRotationCounts() {
        var client = getClient();
        var campId = getCampId();
        if (!client || !campId) return Promise.resolve(false);

        return client
            .from(TABLE)
            .delete()
            .eq('camp_id', campId)
            .then(function(result) {
                if (result.error) {
                    console.error('[RotationCloud] Clear error:', result.error.message);
                    return false;
                }
                _cache = null;
                console.log('[RotationCloud] Cleared all rotation data');
                return true;
            })
            .catch(function(e) {
                console.error('[RotationCloud] Clear failed:', e);
                return false;
            });
    }

    function invalidateCache() {
        _cache = null;
    }

    // =====================================================================
    // EXPOSE
    // =====================================================================
    window.RotationCloud = {
        save: saveRotationCounts,
        load: loadRotationCounts,
        deleteDate: deleteRotationCounts,
        clearAll: clearAllRotationCounts,
        invalidateCache: invalidateCache
    };

    console.log('[RotationCloud] Module ready');
})();
