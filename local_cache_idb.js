/* ============================================================================
 * Local Cache (IndexedDB) — replaces the localStorage warm cache
 *
 * Why this exists:
 *   localStorage has a hard ~5MB per-origin quota. A camp with 480 campers +
 *   parent records + multi-week schedule history routinely blows past it,
 *   causing silent QuotaExceededError on every save. The integration_hooks
 *   layer used to strip "heavy" keys before writing to localStorage to stay
 *   under the cap — but that meant local was always partial and we had to
 *   carry several heuristics (`_campistry_local_write_failed` markers,
 *   `cloudHasMoreData` fallback, etc.) to recover.
 *
 *   IndexedDB has a much larger quota (hundreds of MB to multi-GB depending
 *   on browser policy) and the same per-origin scoping. Moving the warm
 *   cache here removes the quota class of bugs entirely.
 *
 * Shape:
 *   One database `campistry_cache` with one object store `kv`. We store the
 *   ENTIRE settings blob under the single key `'state'` — the cache is
 *   conceptually "what localStorage used to hold," just on a bigger
 *   substrate. integration_hooks still reconstructs the in-memory
 *   `_localCache` object from this on load.
 *
 * API (window.LocalCacheIDB):
 *   .ready             Promise that resolves once the DB is open
 *   .read()            async → returns { state, registry } snapshot
 *   .write(snapshot)   async → persists the snapshot
 *   .clear()           async → wipes the DB (used by resetCloudState)
 *
 * The synchronous API consumers (loadGlobalSettings, etc.) keep working
 * because integration_hooks holds an in-memory `_localCache` and only writes
 * through to IDB asynchronously. IDB is the persistent backing store, not
 * the hot read path.
 * ========================================================================== */

(function () {
    'use strict';

    const DB_NAME = 'campistry_cache';
    const DB_VERSION = 1;
    const STORE = 'kv';
    const KEY_STATE = 'state';
    const KEY_REGISTRY = 'registry'; // mirrors campGlobalRegistry_v1

    let _db = null;
    let _opening = null;

    function _open() {
        if (_db) return Promise.resolve(_db);
        if (_opening) return _opening;

        _opening = new Promise((resolve, reject) => {
            if (!('indexedDB' in window)) {
                reject(new Error('IndexedDB not available'));
                return;
            }

            const req = indexedDB.open(DB_NAME, DB_VERSION);

            req.onupgradeneeded = function (e) {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE);
                }
            };

            req.onsuccess = function (e) {
                _db = e.target.result;
                _db.onversionchange = function () {
                    // Another tab opened with a higher version — close so
                    // they can upgrade. The next read will re-open.
                    try { _db.close(); } catch (_) {}
                    _db = null;
                };
                resolve(_db);
            };

            req.onerror = function (e) {
                _opening = null;
                reject(e.target.error || new Error('IDB open failed'));
            };

            req.onblocked = function () {
                console.warn('[LocalCacheIDB] open blocked — another tab holds an older version');
            };
        });

        return _opening;
    }

    function _tx(mode) {
        return _open().then(db => db.transaction(STORE, mode).objectStore(STORE));
    }

    function _wrap(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function read() {
        try {
            const store = await _tx('readonly');
            const [state, registry] = await Promise.all([
                _wrap(store.get(KEY_STATE)),
                _wrap(store.get(KEY_REGISTRY))
            ]);
            return {
                state: state || null,
                registry: registry || null
            };
        } catch (e) {
            console.warn('[LocalCacheIDB] read failed:', e);
            return { state: null, registry: null };
        }
    }

    async function write(snapshot) {
        // snapshot = { state?, registry? }
        try {
            const store = await _tx('readwrite');
            const ops = [];
            if (snapshot.state !== undefined) {
                ops.push(_wrap(store.put(snapshot.state, KEY_STATE)));
            }
            if (snapshot.registry !== undefined) {
                ops.push(_wrap(store.put(snapshot.registry, KEY_REGISTRY)));
            }
            await Promise.all(ops);
            return true;
        } catch (e) {
            console.warn('[LocalCacheIDB] write failed:', e);
            return false;
        }
    }

    async function clear() {
        try {
            const store = await _tx('readwrite');
            await _wrap(store.clear());
            return true;
        } catch (e) {
            console.warn('[LocalCacheIDB] clear failed:', e);
            return false;
        }
    }

    // One-shot migration: if IDB is empty but localStorage has the legacy
    // `campGlobalSettings_v1` blob, copy it across so users don't lose their
    // warm cache on the first load with the new code. After this runs once,
    // future reads come from IDB and localStorage is no longer consulted.
    async function migrateFromLocalStorage() {
        try {
            const existing = await read();
            if (existing.state) return false; // already migrated

            let stateRaw = null;
            try { stateRaw = localStorage.getItem('campGlobalSettings_v1'); } catch (_) {}
            if (!stateRaw) return false;

            const parsed = JSON.parse(stateRaw);
            if (!parsed || typeof parsed !== 'object') return false;

            let registryRaw = null;
            try { registryRaw = localStorage.getItem('campGlobalRegistry_v1'); } catch (_) {}
            const registry = registryRaw ? JSON.parse(registryRaw) : null;

            await write({ state: parsed, registry });
            console.log('[LocalCacheIDB] Migrated cache from localStorage → IndexedDB');
            return true;
        } catch (e) {
            console.warn('[LocalCacheIDB] migrate failed:', e);
            return false;
        }
    }

    // Eager open + migrate. Resolves once the DB is ready and any
    // localStorage migration has completed. integration_hooks awaits this
    // before its first synchronous getLocalSettings() call.
    const ready = (async () => {
        try {
            await _open();
            await migrateFromLocalStorage();
        } catch (e) {
            console.warn('[LocalCacheIDB] init failed (will fall back to localStorage):', e);
        }
    })();

    window.LocalCacheIDB = {
        ready,
        read,
        write,
        clear
    };

    console.log('💾 LocalCacheIDB v1.0 loaded');
})();
