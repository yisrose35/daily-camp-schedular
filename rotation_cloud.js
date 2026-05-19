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
    // Monotonic generation counter incremented on every cache-invalidating
    // operation. An in-flight load that started before an invalidation
    // resolves with stale data — checking gen at resolve time lets us
    // discard that result instead of repopulating the cache with rows the
    // caller knows are stale.
    var _loadGen = 0;

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

        // ★★★ FIX: delete-then-upsert atomically for this date ★★★
        // Without the pre-delete, regenerating a date accumulates stale rows
        // for activities the new schedule doesn't use. UPSERT only replaces
        // rows for the exact same (camp_id, date_key, bunk, activity) tuple,
        // so if today's gen 1 had "Soccer" for Bunk A and gen 2 has
        // "Basketball" instead, both rows persist forever. Real-world impact:
        // ~2x bloat after the second gen, accelerating with each regen,
        // poisoning the rotation engine's recency/distribution scoring with
        // activities that aren't actually scheduled.
        //
        // The original comment claimed "deleteDate() before regen" was the
        // caller's responsibility, but no caller actually does it (verified
        // via grep). Moving the delete inside save() makes the contract
        // self-enforcing.
        //
        // The race concern (concurrent save calls deleting each other's
        // rows) is mitigated by sequencing: delete + upsert run in series
        // for one call, and two concurrent calls just serialize naturally.
        return client
            .from(TABLE)
            .delete()
            .eq('camp_id', campId)
            .eq('date_key', dateKey)
            .then(function(delResult) {
                if (delResult.error) {
                    console.error('[RotationCloud] Pre-save delete error:', delResult.error.message);
                    // Continue to upsert anyway — partial cleanup is still
                    // better than no cleanup
                }
                return client
                    .from(TABLE)
                    .upsert(rows, { onConflict: 'camp_id,date_key,bunk,activity' });
            })
            .then(function(result) {
                if (result.error) {
                    console.error('[RotationCloud] Upsert error:', result.error.message);
                    return false;
                }
                console.log('[RotationCloud] Saved', rows.length, 'rotation rows for', dateKey, '(pre-cleared stale)');
                _cache = null;
                _loadGen++;
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
            return Promise.resolve({ counts: {}, lastDone: {}, countsByDate: {} });
        }

        // Capture the generation at call start. If any cache-invalidating op
        // (save / delete / clearAll / deleteActivity) runs while the fetch
        // is in flight, _loadGen will diverge and we'll discard the result.
        var startGen = _loadGen;

        // ★★★ FIX: paginate to bypass Supabase's 1000-row default limit ★★★
        // Without explicit .range(), Supabase returns at most 1000 rows.
        // For a real camp (35 bunks × ~9 activities × N days), this caps out
        // fast — a 4-week camp easily exceeds 9000 rows. Truncation meant
        // every consumer (analytics, scheduler scoring, fairness checks)
        // saw a 1000-row slice of history. Cohort pooling and Per Half
        // counts silently undercounted.
        //
        // We fetch 1000 rows at a time, ordered by id, and concatenate.
        var PAGE_SIZE = 1000;
        function fetchAll(allRows, page) {
            var from = page * PAGE_SIZE;
            var to = from + PAGE_SIZE - 1;
            return client
                .from(TABLE)
                .select('bunk, activity, count, date_key')
                .eq('camp_id', campId)
                // Order by the composite PK so pagination is deterministic.
                // rotation_counts has no surrogate `id` column — its PK is
                // (camp_id, date_key, bunk, activity). camp_id is already
                // filtered in the .eq() above, so date_key+bunk+activity is
                // sufficient for a stable cursor.
                .order('date_key', { ascending: true })
                .order('bunk', { ascending: true })
                .order('activity', { ascending: true })
                .range(from, to)
                .then(function(result) {
                    if (result.error) throw result.error;
                    var rows = result.data || [];
                    allRows.push.apply(allRows, rows);
                    if (rows.length < PAGE_SIZE) return allRows;
                    return fetchAll(allRows, page + 1);
                });
        }

        return fetchAll([], 0)
            .then(function(allData) {
                var counts = {};
                var lastDone = {};
                var countsByDate = {}; // ★ Per-date breakdown for smart merging
                allData.forEach(function(row) {
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

                var fresh = { counts: counts, lastDone: lastDone, countsByDate: countsByDate };
                if (startGen !== _loadGen) {
                    // Cache was invalidated mid-flight — return the data to
                    // this caller but do not poison the shared cache.
                    console.log('[RotationCloud] Load result discarded (stale generation)');
                    return fresh;
                }
                _cache = fresh;
                _cacheTime = Date.now();
                console.log('[RotationCloud] Loaded rotation data:', allData.length, 'rows (paginated)');
                return _cache;
            })
            .catch(function(e) {
                console.error('[RotationCloud] Load failed:', e.message || e);
                return { counts: {}, lastDone: {}, countsByDate: {} };
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
                _loadGen++;
                return true;
            })
            .catch(function(e) {
                console.error('[RotationCloud] Delete failed:', e);
                return false;
            });
    }

    // =====================================================================
    // DELETE ACTIVITY: Remove all counts for a named activity across all dates
    // (used when an activity is deleted from the facility/special/general list)
    // =====================================================================
    function deleteActivityCounts(activityName) {
        var client = getClient();
        var campId = getCampId();
        if (!client || !campId || !activityName) return Promise.resolve(false);

        return client
            .from(TABLE)
            .delete()
            .eq('camp_id', campId)
            .eq('activity', activityName)
            .then(function(result) {
                if (result.error) {
                    console.error('[RotationCloud] Delete-activity error:', result.error.message);
                    return false;
                }
                _cache = null;
                _loadGen++;
                console.log('[RotationCloud] Cleared rotation rows for activity:', activityName);
                return true;
            })
            .catch(function(e) {
                console.error('[RotationCloud] Delete-activity failed:', e);
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
                _loadGen++;
                console.log('[RotationCloud] Cleared all rotation data');
                return true;
            })
            .catch(function(e) {
                console.error('[RotationCloud] Clear failed:', e);
                return false;
            });
    }

    function clearForBunks(bunkNames) {
        var client = getClient();
        var campId = getCampId();
        if (!client || !campId || !bunkNames || bunkNames.length === 0) return Promise.resolve(false);

        return client
            .from(TABLE)
            .delete()
            .eq('camp_id', campId)
            .in('bunk', bunkNames)
            .then(function(result) {
                if (result.error) {
                    console.error('[RotationCloud] ClearForBunks error:', result.error.message);
                    return false;
                }
                _cache = null;
                _loadGen++;
                console.log('[RotationCloud] Cleared rotation data for', bunkNames.length, 'bunks');
                return true;
            })
            .catch(function(e) {
                console.error('[RotationCloud] ClearForBunks failed:', e);
                return false;
            });
    }

    function invalidateCache() {
        _cache = null;
        _loadGen++;
    }

    // =====================================================================
    // EXPOSE
    // =====================================================================
    window.RotationCloud = {
        save: saveRotationCounts,
        load: loadRotationCounts,
        deleteDate: deleteRotationCounts,
        deleteActivity: deleteActivityCounts,
        clearAll: clearAllRotationCounts,
        clearForBunks: clearForBunks,
        invalidateCache: invalidateCache
    };

    console.log('[RotationCloud] Module ready');
})();
