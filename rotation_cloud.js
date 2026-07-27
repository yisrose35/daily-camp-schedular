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

    // ★ HR-7: rotation-epoch reader (Half Reset watermark). Pre-epoch
    // rotation_counts rows stay in the table as history but are invisible
    // to every aggregate consumer — a non-deleting, reversible reset.
    // Local fallback because this module may load before scheduler_core_utils.
    function getRotationEpoch() {
        try {
            if (window.SchedulerCoreUtils && typeof window.SchedulerCoreUtils.getRotationEpoch === 'function') {
                return window.SchedulerCoreUtils.getRotationEpoch();
            }
            var e = window.loadGlobalSettings ? window.loadGlobalSettings('rotationEpoch') : null;
            var d = (typeof e === 'string') ? e : (e && e.date);
            return (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) ? d : null;
        } catch (_) { return null; }
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
    // DERIVE: Extract rotation counts from a day's scheduleAssignments.
    // Single source of truth for what "counts" as a rotation activity —
    // used by saveRotationCounts AND the backfill/reconcile utility, so a
    // comparison between derived and stored counts can never drift.
    // Returns { 'bunk|activity': count }.
    // =====================================================================
    // ★ The per-entry decision now lives in ONE place —
    //   SchedulerCoreUtils.rotationActivityForEntry — so this store and the
    //   local historicalCounts rebuild can never drift apart again. The inline
    //   fallback below only runs if scheduler_core_utils.js failed to load.
    function rotationActivityForEntry(entry, validActivities) {
        if (window.SchedulerCoreUtils && typeof window.SchedulerCoreUtils.rotationActivityForEntry === 'function') {
            return window.SchedulerCoreUtils.rotationActivityForEntry(entry, validActivities);
        }
        if (!entry || entry.continuation || entry._isTransition) return null;
        if (entry._h2h || entry._leagueName || entry._isSpecialtyLeague || entry._league) return null;
        var actName = entry._activity || entry.sport || '';
        if (!actName) return null;
        if (!validActivities.has(actName) && entry.sport && validActivities.has(entry.sport)) {
            actName = entry.sport;
        }
        var actLower = String(actName).toLowerCase();
        if (actLower === 'free' || actLower === 'free play' || actLower.indexOf('transition') !== -1) return null;
        if (!validActivities.has(actName)) return null;
        return actName;
    }

    function deriveCounts(scheduleAssignments) {
        var sched = scheduleAssignments || {};
        var validActivities = getValidActivityNames();
        var counts = {};

        Object.keys(sched).forEach(function(bunk) {
            (sched[bunk] || []).forEach(function(entry) {
                var actName = rotationActivityForEntry(entry, validActivities);
                if (!actName) return;
                var key = bunk + '|' + actName;
                counts[key] = (counts[key] || 0) + 1;
            });
        });

        return counts;
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

        var counts = deriveCounts(scheduleAssignments);

        // ★★★ BUNK-SCOPED PRE-DELETE ★★★
        // The pre-delete below exists so a regenerate can't leave stale rows for
        // activities the new schedule dropped (UPSERT only replaces the exact
        // (camp_id, date_key, bunk, activity) tuple, so gen 1's "Soccer" would
        // otherwise outlive gen 2's "Basketball" forever).
        //
        // It used to delete the WHOLE camp-date and re-insert only whatever bunks
        // were in the caller's memory. Every other write to a day's data is
        // carefully division-scoped (daily_schedules filters to the user's own
        // bunks and merges per-bunk newest-wins) — this one was not, so any client
        // holding a partial grid (init race, scheduler whose cross-division merge
        // hadn't landed, offline session) silently erased other divisions' rotation
        // history for that date. rotation_backfill's daily auto-reconcile then
        // replayed that same delete across up to 90 past dates.
        //
        // Scope the delete to the bunks this payload actually carries. Bunks the
        // caller owns still get fully re-derived (a bunk present with zero credited
        // activities correctly ends up with no rows); bunks the caller can't see are
        // left alone. Callers that genuinely mean "clear the whole day" use
        // deleteDate() / clearAll(), which are unchanged.
        var payloadBunks = Object.keys(scheduleAssignments || {});

        // Refuse a no-op write rather than deleting on the way to inserting
        // nothing — mirrors the empty-save guard on daily_schedules. An empty
        // grid is what an un-hydrated page looks like, not a cleared day.
        if (payloadBunks.length === 0) {
            console.warn('[RotationCloud] Empty schedule payload for ' + dateKey + ' — refusing to touch rotation rows (use deleteDate to clear a day)');
            return Promise.resolve(false);
        }

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

        // The race concern (concurrent save calls deleting each other's rows) is
        // mitigated twice over: delete + upsert run in series for one call, and
        // the delete now only covers bunks this caller owns, so two schedulers
        // saving the same date no longer intersect at all.
        return client
            .from(TABLE)
            .delete()
            .eq('camp_id', campId)
            .eq('date_key', dateKey)
            .in('bunk', payloadBunks)
            .then(function(delResult) {
                if (delResult.error) {
                    console.error('[RotationCloud] Pre-save delete error:', delResult.error.message);
                    // Continue to upsert anyway — partial cleanup is still
                    // better than no cleanup
                }
                // A day where the caller's bunks earn no rotation credit at all
                // (all Free / all league) is legitimate — the scoped delete above
                // already cleared them, so there is simply nothing to insert.
                if (rows.length === 0) return { error: null };
                return client
                    .from(TABLE)
                    .upsert(rows, { onConflict: 'camp_id,date_key,bunk,activity' });
            })
            .then(function(result) {
                if (result.error) {
                    console.error('[RotationCloud] Upsert error:', result.error.message);
                    return false;
                }
                console.log('[RotationCloud] Saved', rows.length, 'rotation rows for', dateKey,
                            '(' + payloadBunks.length + ' bunks re-derived)');
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
        // ★ HR-7: with an epoch set, fetch only post-epoch rows. Pre-epoch rows
        // stay in the table (never deleted) but drop out of counts/lastDone/
        // countsByDate, so every downstream aggregate (gen preamble overlays,
        // mergeCloudData, analytics seeding, period caps) restarts at the epoch.
        var _hrEpoch = getRotationEpoch();
        function fetchAll(allRows, page) {
            var from = page * PAGE_SIZE;
            var to = from + PAGE_SIZE - 1;
            var q = client
                .from(TABLE)
                .select('bunk, activity, count, date_key')
                .eq('camp_id', campId);
            if (_hrEpoch) q = q.gte('date_key', _hrEpoch); // ★ HR-7
            return q
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
                    // ★ HR-7: belt-and-braces — never aggregate a pre-epoch row
                    // even if the query-side .gte filter was bypassed.
                    if (_hrEpoch && String(row.date_key).substring(0, 10) < _hrEpoch) return;
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
    // RENAME ACTIVITY: Move all counts from oldName → newName across every
    // date, MERGING into any existing newName rows (so renaming onto a name
    // that already has history sums the two), then delete the old-name rows.
    // Used when a facility/special/general activity is renamed so its rotation
    // history follows the new name instead of orphaning under the old one.
    // =====================================================================
    function renameActivityCounts(oldName, newName) {
        var client = getClient();
        var campId = getCampId();
        if (!client || !campId || !oldName || !newName || oldName === newName) {
            return Promise.resolve(false);
        }

        // 1) Read every old-name row, plus every existing new-name row to merge.
        return Promise.all([
            client.from(TABLE).select('date_key,bunk,count').eq('camp_id', campId).eq('activity', oldName),
            client.from(TABLE).select('date_key,bunk,count').eq('camp_id', campId).eq('activity', newName)
        ]).then(function(results) {
            var oldRes = results[0], newRes = results[1];
            if (oldRes.error) { console.error('[RotationCloud] rename read(old) error:', oldRes.error.message); return false; }
            if (newRes.error) { console.error('[RotationCloud] rename read(new) error:', newRes.error.message); return false; }
            var oldRows = oldRes.data || [];
            if (oldRows.length === 0) return true; // nothing to migrate

            // Merge counts per (date_key, bunk): existing new-name count + old count.
            var merged = {};
            (newRes.data || []).forEach(function(r) { merged[r.date_key + '|' + r.bunk] = r.count; });
            oldRows.forEach(function(r) {
                var k = r.date_key + '|' + r.bunk;
                merged[k] = (merged[k] || 0) + r.count;
            });

            var nowIso = new Date().toISOString();
            var rows = Object.keys(merged).map(function(k) {
                var p = k.split('|');
                return { camp_id: campId, date_key: p[0], bunk: p[1], activity: newName, count: merged[k], updated_at: nowIso };
            });

            // 2) Upsert merged new-name rows, THEN delete the old-name rows.
            return client.from(TABLE)
                .upsert(rows, { onConflict: 'camp_id,date_key,bunk,activity' })
                .then(function(up) {
                    if (up.error) { console.error('[RotationCloud] rename upsert error:', up.error.message); return false; }
                    return client.from(TABLE).delete().eq('camp_id', campId).eq('activity', oldName)
                        .then(function(del) {
                            if (del.error) { console.error('[RotationCloud] rename delete(old) error:', del.error.message); return false; }
                            _cache = null;
                            _loadGen++;
                            console.log('[RotationCloud] Renamed activity "' + oldName + '" → "' + newName + '" (' + rows.length + ' rows)');
                            return true;
                        });
                });
        }).catch(function(e) {
            console.error('[RotationCloud] rename failed:', e);
            return false;
        });
    }

    // =====================================================================
    // RENAME BUNK: Move all counts from oldBunk → newBunk across every date +
    // activity, MERGING into any existing newBunk rows, then delete the old-bunk
    // rows. Mirrors renameActivityCounts but on the `bunk` column. Used when a
    // bunk is renamed in Campistry Me so its rotation history follows the new
    // name instead of orphaning under the old one (which would make the renamed
    // bunk look like it has no history and skew fairness).
    // =====================================================================
    function renameBunkCounts(oldBunk, newBunk) {
        var client = getClient();
        var campId = getCampId();
        if (!client || !campId || !oldBunk || !newBunk || oldBunk === newBunk) {
            return Promise.resolve(false);
        }

        // 1) Read every old-bunk row, plus every existing new-bunk row to merge.
        return Promise.all([
            client.from(TABLE).select('date_key,activity,count').eq('camp_id', campId).eq('bunk', oldBunk),
            client.from(TABLE).select('date_key,activity,count').eq('camp_id', campId).eq('bunk', newBunk)
        ]).then(function(results) {
            var oldRes = results[0], newRes = results[1];
            if (oldRes.error) { console.error('[RotationCloud] bunk-rename read(old) error:', oldRes.error.message); return false; }
            if (newRes.error) { console.error('[RotationCloud] bunk-rename read(new) error:', newRes.error.message); return false; }
            var oldRows = oldRes.data || [];
            if (oldRows.length === 0) return true; // nothing to migrate

            // Merge counts per (date_key, activity): existing new-bunk count + old count.
            // Split on the FIRST '|' only — activity names may contain '|', date_key never does.
            var merged = {};
            (newRes.data || []).forEach(function(r) { merged[r.date_key + '|' + r.activity] = r.count; });
            oldRows.forEach(function(r) {
                var k = r.date_key + '|' + r.activity;
                merged[k] = (merged[k] || 0) + r.count;
            });

            var nowIso = new Date().toISOString();
            var rows = Object.keys(merged).map(function(k) {
                var i = k.indexOf('|');
                return { camp_id: campId, date_key: k.slice(0, i), bunk: newBunk, activity: k.slice(i + 1), count: merged[k], updated_at: nowIso };
            });

            // 2) Upsert merged new-bunk rows, THEN delete the old-bunk rows.
            return client.from(TABLE)
                .upsert(rows, { onConflict: 'camp_id,date_key,bunk,activity' })
                .then(function(up) {
                    if (up.error) { console.error('[RotationCloud] bunk-rename upsert error:', up.error.message); return false; }
                    return client.from(TABLE).delete().eq('camp_id', campId).eq('bunk', oldBunk)
                        .then(function(del) {
                            if (del.error) { console.error('[RotationCloud] bunk-rename delete(old) error:', del.error.message); return false; }
                            _cache = null;
                            _loadGen++;
                            console.log('[RotationCloud] Renamed bunk "' + oldBunk + '" → "' + newBunk + '" (' + rows.length + ' rows)');
                            return true;
                        });
                });
        }).catch(function(e) {
            console.error('[RotationCloud] bunk-rename failed:', e);
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
    // COHERENCE-GUARDED SAVE — use this from any path that reads the date
    // and the grid from live globals rather than from a captured payload.
    // =====================================================================
    // saveRotationCounts(dateKey, grid) trusts its caller that the two belong
    // together. Every write to daily_schedules already refuses a mismatched
    // pair (integration_hooks' autosave hook, verifiedScheduleSave, and
    // ScheduleDB.saveSchedule all check _pendingDateTransition /
    // _scheduleAssignmentsDate) — the rotation write sitting next to them did
    // not, so it could still fire during the window where
    // window.currentScheduleDate has already advanced to the new date but
    // window.scheduleAssignments still holds the old one. Because save
    // pre-deletes, that wrote yesterday's activities under today's date_key
    // AND erased today's real rows: the bunk gets credited twice for
    // yesterday and loses credit for today.
    //
    // Returns false (and writes nothing) when the pair is incoherent. The next
    // coherent save on the real owner date persists normally. Inert when the
    // owner stamp is unset, so it can never block a legitimate save.
    function saveRotationCountsGuarded(dateKey, scheduleAssignments, label) {
        if (!dateKey) return Promise.resolve(false);

        if (window._pendingDateTransition) {
            console.warn('[RotationCloud] SKIP save' + (label ? ' (' + label + ')' : '') +
                         ': a date transition is in flight — memory and dateKey are mid-swap');
            return Promise.resolve(false);
        }

        var owner = window._scheduleAssignmentsDate;
        if (owner && owner !== dateKey) {
            console.warn('[RotationCloud] SKIP save' + (label ? ' (' + label + ')' : '') +
                         ': in-memory schedule belongs to ' + owner + ', not ' + dateKey +
                         ' — refusing to write one day\'s activities under another day\'s key');
            return Promise.resolve(false);
        }

        return saveRotationCounts(dateKey, scheduleAssignments);
    }

    // ★★★ CB-66: synchronous read of the already-loaded per-date counts (no fetch,
    // no promise). Lets the solver's period-cap enforcement consult cloud
    // rotation_counts without becoming async. Returns null if nothing is cached.
    function getCachedCountsByDate() {
        return (_cache && _cache.countsByDate) ? _cache.countsByDate : null;
    }

    // ★ Synchronous read of the WHOLE cached payload ({counts, lastDone,
    //   countsByDate}) for RotationEngine.reoverlayCloudCache — lets a solver
    //   that just wiped the rotation history cache re-apply the cloud overlay
    //   without an async load. Returns null if nothing is cached.
    function getCachedData() {
        return _cache || null;
    }

    // =====================================================================
    // EXPOSE
    // =====================================================================
    window.RotationCloud = {
        save: saveRotationCounts,
        saveGuarded: saveRotationCountsGuarded, // ★ for live-globals callers (see above)
        load: loadRotationCounts,
        deleteDate: deleteRotationCounts,
        deleteActivity: deleteActivityCounts,
        renameActivity: renameActivityCounts,
        renameBunk: renameBunkCounts,
        clearAll: clearAllRotationCounts,
        clearForBunks: clearForBunks,
        invalidateCache: invalidateCache,
        getCachedCountsByDate: getCachedCountsByDate, // ★ CB-66: sync per-date counts for period-cap enforcement
        getCachedData: getCachedData, // ★ sync full payload for RotationEngine.reoverlayCloudCache
        deriveCounts: deriveCounts // ★ shared counting rules for the backfill/reconcile utility
    };

    console.log('[RotationCloud] Module ready');
})();
