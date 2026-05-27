// =============================================================================
// campistry_go_persistence.js — Neighborhood persistence & year-over-year diff
//
// Stores neighborhood → bus assignments across runs so route identity survives
// roster churn. Piggybacks on the existing go_standalone_data Supabase table
// (data_type='neighborhoods') — no new migration required. Falls back to
// localStorage when Supabase is not ready.
//
// Payload shape (stored as jsonb):
//   {
//     version: 1,
//     savedAt: ISO,
//     neighborhoods: {
//       [nhId]: {
//         id, primaryName, mode,
//         lastBusId, lastAssignedAt,
//         pinned: bool, pinnedBusId?,
//         lastCamperCount, segmentIds: [stable IDs],
//         history: [{busId, camperCount, savedAt}]  // capped at 3 most recent
//       }
//     }
//   }
//
// Public API:
//   window.GoNhPersistence.load()                        → Promise<payload>
//   window.GoNhPersistence.save(payload)                 → Promise<ok>
//   window.GoNhPersistence.recordAssignment(assignment, result) → Promise<payload>
//   window.GoNhPersistence.getPriorAssignments()         → Promise<{nhId → busId}>
//   window.GoNhPersistence.pin(nhId, busId)              → Promise<payload>
//   window.GoNhPersistence.unpin(nhId)                   → Promise<payload>
//   window.GoNhPersistence.diff(prev, current)           → [{nhId, fromBus, toBus, reason}]
// =============================================================================

window.GoNhPersistence = (function () {
    'use strict';

    const DATA_TYPE = 'neighborhoods';
    const LS_KEY = 'campistry_go_neighborhoods_v1';
    const VERSION = 1;
    const HISTORY_CAP = 3;

    const EMPTY = () => ({ version: VERSION, savedAt: null, neighborhoods: {} });

    // -------------------------------------------------------------------------
    // Backend access (Supabase preferred, localStorage mirror)
    // -------------------------------------------------------------------------
    function cloudAvailable() { return !!window.GoCloudSync; }

    async function loadFromCloud() {
        if (!cloudAvailable()) return null;
        try {
            const all = await window.GoCloudSync.loadAll();
            if (!all) return null;
            return all[DATA_TYPE] || null;
        } catch (e) {
            console.warn('[GoNhPersistence] Cloud load failed:', e.message);
            return null;
        }
    }

    async function saveToCloud(payload) {
        if (!cloudAvailable()) return { ok: false, reason: 'no-cloud' };
        try { return await window.GoCloudSync.save(DATA_TYPE, payload); }
        catch (e) { return { ok: false, error: e }; }
    }

    function loadFromLocal() {
        try {
            const raw = localStorage.getItem(LS_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (_) { return null; }
    }

    function saveToLocal(payload) {
        try { localStorage.setItem(LS_KEY, JSON.stringify(payload)); return true; }
        catch (_) { return false; }
    }

    // -------------------------------------------------------------------------
    // Public
    // -------------------------------------------------------------------------
    async function load() {
        // Cloud is authoritative if available; local is the offline mirror.
        const cloud = await loadFromCloud();
        if (cloud && cloud.version === VERSION) { saveToLocal(cloud); return cloud; }
        const local = loadFromLocal();
        if (local && local.version === VERSION) return local;
        return EMPTY();
    }

    async function save(payload) {
        payload.savedAt = new Date().toISOString();
        payload.version = VERSION;
        saveToLocal(payload);
        const cloud = await saveToCloud(payload);
        return cloud.ok || !cloudAvailable();
    }

    // Record the outcome of a routing run: who ended up on which bus.
    //   assignment : output of packIntoBuses()  [{busId, neighborhoodIds, camperCount, ...}]
    //   result     : output of buildNeighborhoods() — gives names/modes/segments
    async function recordAssignment(assignment, result) {
        const payload = await load();
        const now = new Date().toISOString();

        // Build nhId → busId map from assignment (split parts point back to parent)
        const busByNh = {};
        for (const bus of assignment) {
            for (const nhId of bus.neighborhoodIds) {
                // Split pieces carry 'parentId' via their ID suffix "_pN" — map back
                const parentId = nhId.replace(/_p\d+$/, '');
                busByNh[parentId] = bus.busId;
            }
        }

        for (const nh of result.neighborhoods) {
            const parentId = nh.id.replace(/_p\d+$/, '');
            const busId = busByNh[parentId];
            if (!busId) continue;

            const existing = payload.neighborhoods[parentId] || {
                id: parentId, history: [],
            };
            // Respect pins — don't overwrite pinnedBusId
            const pinned = !!existing.pinned;

            payload.neighborhoods[parentId] = {
                id: parentId,
                primaryName: nh.primaryName,
                mode: nh.mode,
                segmentIds: nh.segmentIds,
                lastBusId: busId,
                lastAssignedAt: now,
                lastCamperCount: nh.camperCount,
                pinned,
                pinnedBusId: pinned ? existing.pinnedBusId : undefined,
                history: [
                    { busId, camperCount: nh.camperCount, savedAt: now },
                    ...(existing.history || []),
                ].slice(0, HISTORY_CAP),
            };
        }

        await save(payload);
        return payload;
    }

    async function getPriorAssignments() {
        const payload = await load();
        const map = {};
        for (const nh of Object.values(payload.neighborhoods)) {
            // Pin takes precedence over last-known
            if (nh.pinned && nh.pinnedBusId) map[nh.id] = nh.pinnedBusId;
            else if (nh.lastBusId) map[nh.id] = nh.lastBusId;
        }
        return map;
    }

    async function pin(nhId, busId) {
        const payload = await load();
        const existing = payload.neighborhoods[nhId] || { id: nhId, history: [] };
        payload.neighborhoods[nhId] = { ...existing, pinned: true, pinnedBusId: busId };
        await save(payload);
        return payload;
    }

    async function unpin(nhId) {
        const payload = await load();
        const existing = payload.neighborhoods[nhId];
        if (!existing) return payload;
        payload.neighborhoods[nhId] = { ...existing, pinned: false, pinnedBusId: undefined };
        await save(payload);
        return payload;
    }

    // Compare two payloads and produce a human-readable change list.
    // Each entry: {nhId, primaryName, fromBus, toBus, reason}
    function diff(prev, current) {
        const out = [];
        const prevNhs = prev?.neighborhoods || {};
        const curNhs = current?.neighborhoods || {};

        for (const [id, cur] of Object.entries(curNhs)) {
            const before = prevNhs[id];
            if (!before) {
                out.push({
                    nhId: id, primaryName: cur.primaryName,
                    fromBus: null, toBus: cur.lastBusId,
                    reason: 'new neighborhood (' + cur.lastCamperCount + ' campers)',
                });
                continue;
            }
            if (before.lastBusId !== cur.lastBusId) {
                const delta = cur.lastCamperCount - (before.lastCamperCount || 0);
                const deltaStr = delta === 0 ? 'same count' : (delta > 0 ? '+' + delta : '' + delta) + ' campers';
                out.push({
                    nhId: id, primaryName: cur.primaryName,
                    fromBus: before.lastBusId, toBus: cur.lastBusId,
                    reason: cur.pinned ? 'pinned' : ('reassigned (' + deltaStr + ')'),
                });
            }
        }
        for (const [id, before] of Object.entries(prevNhs)) {
            if (!curNhs[id]) {
                out.push({
                    nhId: id, primaryName: before.primaryName,
                    fromBus: before.lastBusId, toBus: null,
                    reason: 'neighborhood no longer present (empty this year)',
                });
            }
        }
        return out;
    }

    return { load, save, recordAssignment, getPriorAssignments, pin, unpin, diff };
})();
