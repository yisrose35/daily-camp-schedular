// =============================================================================
// integration_hooks.js v6.8 — CAMPISTRY SCHEDULER INTEGRATION
// =============================================================================
//
// v6.8 FIXES:
// - ★★★ CRITICAL: Scheduler role guard for camp_state — moved to TOP of
//   executeBatchSync so neither SELECT nor UPSERT is attempted for non-admin
// - ★★★ CRITICAL: hydrateFromCloud gracefully handles RLS denial for schedulers
// - Fixes "no grades created" error when loading as scheduler
// - Fixes generation being blocked by 403 on camp_state write
//
// v6.6 FIXES:
// - ★★★ CRITICAL: Multi-date save fix — ALL dates now cloud-synced, not just one
// - ★ localStorage persistence restored (was silently missing for daily_schedules)
// - ★ Secondary dates saved via ScheduleDB with skipFilter + staggered timing
// - ★ Filters out poisoned root keys like 'updated_at' from date iteration
//
// v6.5 FIXES:
// - ★ RAINY DAY PERSISTENCE - Properly saves/loads isRainyDay and rainyDayStartTime
// - ★ BACKWARD COMPATIBILITY - Includes rainyDayMode for legacy support
//
// v6.4 FIXES:
// - ★ FIXED: Duplicate save notifications - added deduplication with 3s threshold
// - ★ FIXED: Multiple rapid saves now coalesced into single operation
//
// v6.3 FIXES:
// - ★ NEW: CloudPermissions unified permission helper
// - ★ IMPROVED: Better network awareness in save operations
// - ★ IMPROVED: unifiedTimes hydration from cloud
//
// v6.2 FIXES:
// - ★ FIXED DUPLICATE saveGlobalSettings - single authoritative handler
// - ★ AUTO-SAVE BEFORE DATE CHANGE - prevents data loss when switching dates
// - ★ BEFOREUNLOAD HANDLER - saves on page exit
// - ★ SAVE VERIFICATION - confirms cloud writes with retry
// - ★ USER NOTIFICATIONS - shows save status to user
// - ★ CONSOLIDATED PATCHES - removed competing save handlers
//
// v6.1 FIXES:
// - ★ BYPASS SAVE GUARD - Skips remote merge during _postEditInProgress
//
// v6.0 FIXES:
// - ★ BATCHED GLOBAL SETTINGS SYNC - Multiple calls are batched into one cloud write
// - ★ ALL DATA TYPES sync to camp_state (divisions, bunks, activities, fields, etc.)
//
// =============================================================================

(function() {
    'use strict';

    console.log('🔗 Campistry Integration Hooks v6.8 loading...');

    // =========================================================================
    // CONFIGURATION
    // =========================================================================
    
    const CONFIG = {
        SYNC_DEBOUNCE_MS: 500,
        LOCAL_STORAGE_KEY: 'campGlobalSettings_v1',
        DEBUG: false,
        SAVE_MAX_RETRIES: 3,
        SAVE_RETRY_DELAY_MS: 2000,
        SHOW_NOTIFICATIONS: true
    };

    // =========================================================================
    // STATE
    // =========================================================================
    
    let _pendingChanges = {};
    let _syncTimeout = null;
    let _isSyncing = false;
    let _onlineRetryRegistered = false;
    let _localCache = null;
    let _idbPreloadSucceeded = false;
    let _cloudHydrationDone = false;
    let _roleCheckRetries = 0;
    let _lastSyncTime = 0;
    let _datePickerHooked = false;
    let _datePickerRetries = 0;
    let _scheduleCloudLoadDone = false;
    
    // ★★★ v6.4: Deduplication state for save operations ★★★
    let _lastSaveKey = null;
    let _lastSaveTime = 0;
    let _saveInProgress = false;
    const SAVE_DEDUP_MS = 3000; // Ignore duplicate saves within 3 seconds

    // Cached after each successful executeBatchSync so the beforeunload
    // handler can build a fetch-keepalive request synchronously. Without
    // this, the supabase-js upsert in beforeunload dies with the tab on
    // slow networks because supabase-js doesn't set keepalive: true.
    let _cachedAccessToken = null;

    // =========================================================================
    // LOGGING
    // =========================================================================

    function log(...args) {
        if (CONFIG.DEBUG) {
            console.log('🔗 [Hooks]', ...args);
        }
    }

    function logError(...args) {
        console.error('🔗 [Hooks] ERROR:', ...args);
    }

    // =========================================================================
    // SECONDARY-SAVE HASH HELPERS (module-scoped so hydration paths can seed
    // the baseline before any saveGlobalSettings call). Without seeding, the
    // very first save after page load fans out one cloud save per hydrated
    // past date.
    // =========================================================================
    // Single source of truth for daily-data content hashes. Used both by
    // _seedSecondarySaveHashes (to baseline hydrated dates) and by
    // saveGlobalSettings's secondary-save dedup. The two used to drift —
    // the seeder hashed only sa+la, while the saveGlobalSettings copy was
    // upgraded to also include rainy/divisionTimes meta. Result: every
    // hydrated past date fired a spurious cloud save on the first
    // post-hydration write because the seeded hash never matched.
    function _hashDateDataModule(d) {
        try {
            const sa = d?.scheduleAssignments || {};
            const la = d?.leagueAssignments || {};
            const dt = d?.divisionTimes || {};
            const dtSerialized = Object.keys(dt).sort()
                .map(k => k + ':' + JSON.stringify(dt[k]))
                .join('|');
            const meta = JSON.stringify({
                r: !!d?.isRainyDay,
                rt: d?.rainyDayStartTime || '',
                dt: dtSerialized
            });
            const s = JSON.stringify(sa) + '|' + JSON.stringify(la) + '|' + meta;
            let h = 0;
            for (let i = 0; i < s.length; i++) {
                h = ((h << 5) - h + s.charCodeAt(i)) | 0;
            }
            return h;
        } catch (_) { return Math.random(); }
    }
    window._seedSecondarySaveHashes = function (allDaily) {
        if (!window._secondarySaveHash) window._secondarySaveHash = {};
        if (!allDaily || typeof allDaily !== 'object') return 0;
        let seeded = 0;
        Object.keys(allDaily).forEach(dk => {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) return;
            const d = allDaily[dk];
            if (!d || !d.scheduleAssignments) return;
            if (window._secondarySaveHash[dk] === undefined) {
                window._secondarySaveHash[dk] = _hashDateDataModule(d);
                seeded++;
            }
        });
        return seeded;
    };

    // =========================================================================
    // ★★★ v6.8: ROLE HELPER (available before CloudPermissions freeze) ★★★
    // =========================================================================
    
    function _canWriteCampState() {
        const role = window.AccessControl?.getCurrentRole?.() ||
                     window.CampistryDB?.getRole?.() ||
                     localStorage.getItem('campistry_role') ||
                     'viewer';
        return role === 'owner' || role === 'admin';
    }

    function _canReadCampState() {
        const role = window.AccessControl?.getCurrentRole?.() ||
                     window.CampistryDB?.getRole?.() ||
                     localStorage.getItem('campistry_role') ||
                     'viewer';
        return role === 'owner' || role === 'admin' || role === 'scheduler';
    }

    // =========================================================================
    // ★★★ NEW: UNIFIED CLOUDPERMISSIONS HELPER ★★★
    // =========================================================================
    
    /**
     * CloudPermissions - Unified permission checking across all systems.
     * Provides consistent role and permission access regardless of which
     * permission system is initialized.
     */
    window.CloudPermissions = {
        /**
         * Get current user's role with priority chain.
         */
        getRole() {
            // Priority: AccessControl > CampistryDB > localStorage
            return window.AccessControl?.getCurrentRole?.() ||
                   window.CampistryDB?.getRole?.() ||
                   localStorage.getItem('campistry_role') || 
                   'viewer';
        },
        
        /**
         * Check if user has owner or admin access.
         */
        hasFullAccess() {
            const role = this.getRole();
            return role === 'owner' || role === 'admin';
        },
        
        /**
         * Check if user is the camp owner.
         */
        isOwner() {
            return this.getRole() === 'owner';
        },
        
        /**
         * Check if user is an admin (includes owner).
         */
        isAdmin() {
            const role = this.getRole();
            return role === 'owner' || role === 'admin';
        },
        
        /**
         * Get editable bunks with proper fallback chain.
         */
        getEditableBunks() {
            // Priority: AccessControl > PermissionsDB > compute from divisions
            const acDivisions = window.AccessControl?.getEditableDivisions?.() || [];
            if (acDivisions.length > 0) {
                const bunks = [];
                const divisions = window.divisions || {};
                acDivisions.forEach(divName => {
                    const divData = divisions[divName] || divisions[String(divName)];
                    if (divData?.bunks) {
                        bunks.push(...divData.bunks);
                    }
                });
                return bunks.map(String);
            }
            
            // Fallback to PermissionsDB
            const permBunks = window.PermissionsDB?.getEditableBunks?.() || [];
            if (permBunks.length > 0) {
                return permBunks.map(String);
            }
            
            // Full access fallback
            if (this.hasFullAccess()) {
                const allBunks = [];
                const divisions = window.divisions || {};
                Object.values(divisions).forEach(div => {
                    if (div.bunks) allBunks.push(...div.bunks);
                });
                return allBunks.map(String);
            }
            
            return [];
        },
        
        /**
         * Get editable divisions with proper fallback chain.
         */
        getEditableDivisions() {
            // Full access gets everything
            if (this.hasFullAccess()) {
                return Object.keys(window.divisions || {});
            }
            
            // Priority: AccessControl > PermissionsDB
            const acDivisions = window.AccessControl?.getEditableDivisions?.() || [];
            if (acDivisions.length > 0) {
                return acDivisions;
            }
            
            return window.PermissionsDB?.getEditableDivisions?.() || [];
        },
        
        /**
         * Check if user can edit a specific division.
         */
        canEditDivision(divisionName) {
            if (this.hasFullAccess()) return true;
            return this.getEditableDivisions().includes(divisionName);
        },
        
        /**
         * Check if user can edit a specific bunk.
         */
        canEditBunk(bunkName) {
            if (this.hasFullAccess()) return true;
            return this.getEditableBunks().includes(String(bunkName));
        },
        
        /**
         * Get current user info with fallback chain.
         */
        getUserInfo() {
            // Priority: AccessControl > CampistryDB > membership
            const acInfo = window.AccessControl?.getCurrentUserInfo?.();
            if (acInfo) return acInfo;
            
            const membership = window._campistryMembership;
            if (membership) {
                return {
                    userId: window.CampistryDB?.getUserId?.(),
                    name: membership.name,
                    email: window.CampistryDB?.getSession?.()?.user?.email
                };
            }
            
            const session = window.CampistryDB?.getSession?.();
            if (session?.user) {
                return {
                    userId: session.user.id,
                    email: session.user.email,
                    name: session.user.email?.split('@')[0] || 'Unknown'
                };
            }
            
            return null;
        },
        
        /**
         * Diagnostic function.
         */
        diagnose() {
            console.log('═══════════════════════════════════════════════════════');
            console.log('🔐 CLOUDPERMISSIONS DIAGNOSTIC');
            console.log('═══════════════════════════════════════════════════════');
            console.log('Role:', this.getRole());
            console.log('Has Full Access:', this.hasFullAccess());
            console.log('Is Owner:', this.isOwner());
            console.log('Editable Divisions:', this.getEditableDivisions());
            console.log('Editable Bunks:', this.getEditableBunks().length);
            console.log('User Info:', this.getUserInfo());
            console.log('');
            console.log('Sources:');
            console.log('  AccessControl role:', window.AccessControl?.getCurrentRole?.());
            console.log('  CampistryDB role:', window.CampistryDB?.getRole?.());
            console.log('  localStorage role:', localStorage.getItem('campistry_role'));
            console.log('═══════════════════════════════════════════════════════');
        }
    };
// ★★★ SECURITY: Freeze to prevent monkey-patching ★★★
    Object.freeze(window.CloudPermissions);
    Object.defineProperty(window, 'CloudPermissions', {
        value: window.CloudPermissions,
        writable: false,
        configurable: false
    });
    // =========================================================================
    // USER NOTIFICATIONS
    // =========================================================================

    function showNotification(message, type = 'info') {
        if (!CONFIG.SHOW_NOTIFICATIONS) return;

        // Remove any existing notification from this module
        const existing = document.querySelector('.hooks-notification');
        if (existing) existing.remove();

        const colors = {
            success: '#22c55e',
            error: '#ef4444',
            warning: '#f59e0b',
            info: '#3b82f6'
        };

        const notification = document.createElement('div');
        notification.className = 'hooks-notification';
        notification.style.cssText = `
            position: fixed;
            bottom: 70px;
            right: 20px;
            background: ${colors[type] || colors.info};
            color: white;
            padding: 10px 16px;
            border-radius: 6px;
            font-size: 13px;
            font-weight: 500;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 999998;
            animation: hooksSlideIn 0.3s ease;
        `;
        notification.textContent = message;

        if (!document.querySelector('#hooks-notification-styles')) {
            const style = document.createElement('style');
            style.id = 'hooks-notification-styles';
            style.textContent = `
                @keyframes hooksSlideIn {
                    from { transform: translateX(100%); opacity: 0; }
                    to { transform: translateX(0); opacity: 1; }
                }
            `;
            document.head.appendChild(style);
        }

        document.body.appendChild(notification);
        setTimeout(() => notification.remove(), type === 'error' ? 5000 : 2500);
    }

    // =========================================================================
    // LOCAL STORAGE HELPERS
    // =========================================================================

    // Migrate the legacy `limitUsage` property name on fields and special activities
    // to `accessRestrictions` (semantic rename — same shape, clearer name). Old saved
    // data still loads; future saves use the new name. Runs at most once per page load:
    // once we've upgraded the in-memory copy and any new saves write the new key,
    // re-walking thousands of fields/specials on every cache miss is pure overhead.
    let _accessRestrictionsMigrated = false;
    function _migrateAccessRestrictionsKey(settings) {
        if (_accessRestrictionsMigrated) return settings;
        if (!settings || typeof settings !== 'object') return settings;
        const fields = settings?.app1?.fields;
        if (Array.isArray(fields)) {
            for (const f of fields) {
                if (f && f.limitUsage && !f.accessRestrictions) {
                    f.accessRestrictions = f.limitUsage;
                }
            }
        }
        const specials = settings?.specialActivities || settings?.app1?.specialActivities;
        if (Array.isArray(specials)) {
            for (const s of specials) {
                if (s && s.limitUsage && !s.accessRestrictions) {
                    s.accessRestrictions = s.limitUsage;
                }
            }
        }
        _accessRestrictionsMigrated = true;
        return settings;
    }

    // ─── IndexedDB write-through ──────────────────────────────────────────
    // The in-memory `_localCache` is the synchronous read path. IndexedDB is
    // the persistent backing store (replaces localStorage for the FULL state,
    // which routinely exceeded the 5MB localStorage quota). localStorage
    // still receives a stripped copy so the next page load has SOMETHING to
    // hand to early sync readers before LocalCacheIDB.read() resolves.
    let _idbWriteScheduled = false;
    let _idbPendingSnapshot = null;
    function _scheduleIdbWrite(data) {
        _idbPendingSnapshot = data;
        if (_idbWriteScheduled) return;
        _idbWriteScheduled = true;
        // Coalesce bursts (importRows fires many setLocalSettings in a row)
        // into a single IDB transaction.
        Promise.resolve().then(() => {
            const snapshot = _idbPendingSnapshot;
            _idbPendingSnapshot = null;
            _idbWriteScheduled = false;
            if (!window.LocalCacheIDB) return;
            const registry = (snapshot.divisions || snapshot.bunks)
                ? { divisions: snapshot.divisions || {}, bunks: snapshot.bunks || [] }
                : undefined;
            window.LocalCacheIDB.write({ state: snapshot, registry })
                .catch(e => log('IDB write-through failed:', e?.message || e));
        });
    }

    async function preloadFromIdb() {
        if (!window.LocalCacheIDB) return;
        try {
            await window.LocalCacheIDB.ready;
            const snap = await window.LocalCacheIDB.read();
            if (snap && snap.state && typeof snap.state === 'object') {
                // IDB has the FULL state (heavy keys included). Overwrite
                // whatever sync-fallback we read from localStorage at boot.
                _localCache = _migrateAccessRestrictionsKey(snap.state);
                _idbPreloadSucceeded = true;
                log('Preloaded full state from IndexedDB');
                // Clear the stale localStorage-failure marker — IDB has the
                // complete state so local data is trustworthy for merge.
                try { sessionStorage.removeItem('_campistry_local_write_failed'); } catch (_) {}
                try { localStorage.removeItem('_campistry_local_write_failed'); } catch (_) {}
            }
        } catch (e) {
            log('IDB preload failed:', e?.message || e);
        }
    }

    function getLocalSettings() {
        if (_localCache !== null) {
            return _localCache;
        }

        // Sync fallback: read the stripped localStorage copy. This gives
        // early callers SOMETHING before preloadFromIdb() resolves and
        // overwrites _localCache with the full IDB state.
        try {
            const raw = localStorage.getItem(CONFIG.LOCAL_STORAGE_KEY);
            _localCache = _migrateAccessRestrictionsKey(raw ? JSON.parse(raw) : {});
            return _localCache;
        } catch (e) {
            logError('Failed to read local settings:', e);
            return {};
        }
    }

    function setLocalSettings(data) {
        try {
            _localCache = data;

            // ─── IndexedDB: full state write-through ──────────────────────
            // This is the new canonical local persistence layer. No quota
            // gymnastics needed — IDB has plenty of room.
            _scheduleIdbWrite(data);

            // ─── localStorage: stripped sync-init snapshot ────────────────
            // Heavy keys are excluded so a full-camp blob doesn't blow the
            // 5MB quota. localStorage is now ONLY used as the fast sync
            // fallback for early callers on the next page load — IDB holds
            // the complete state and overwrites _localCache shortly after.
            const lite = Object.assign({}, data);
            if (lite.campistryGo) {
                lite.campistryGo = Object.assign({}, lite.campistryGo);
                delete lite.campistryGo.savedRoutes;
                delete lite.campistryGo.addresses;
            }
            // Strip keys that grow unbounded with camp size; localStorage's
            // ~5MB ceiling otherwise drops the entire write on big camps.
            // The full state stays in IDB; this snapshot is just the
            // sync-fast-path fallback for the next page load.
            delete lite.daily_schedules;
            delete lite.rotationHistory;
            delete lite.historicalCounts;
            delete lite.historicalCountedDates;
            delete lite.smartTileHistory;
            delete lite.specialtyLeagueHistory;
            delete lite.leagueHistory;
            delete lite.leaguesByName;
            delete lite.playoffsByLeague;
            if (lite.app1) {
                lite.app1 = Object.assign({}, lite.app1);
                delete lite.app1.camperRoster;
            }
            if (lite.campistryMe) {
                lite.campistryMe = Object.assign({}, lite.campistryMe);
                delete lite.campistryMe.families;
                delete lite.campistryMe.enrollments;
                delete lite.campistryMe.payments;
                delete lite.campistryMe.finance;
                delete lite.campistryMe.bunkAssignments;
            }

            try {
                const json = JSON.stringify(lite);
                localStorage.setItem(CONFIG.LOCAL_STORAGE_KEY, json);
                // ★ #V2-1 tail: CAMPISTRY_LOCAL_CACHE is a write-only CROSS-TAB BEACON — its
                //   VALUE is never read anywhere (the app1 'storage' listener reacts to the
                //   KEY changing, then re-reads campGlobalSettings_v1 / IDB). Writing the full
                //   ~839KB config here was an EXACT duplicate of the line above, doubling the
                //   config's localStorage footprint (~1.6MB) and pushing it toward quota.
                //   Write a tiny unique beacon instead — the storage event still fires (and
                //   the campGlobalSettings_v1 write above already triggers the same listener).
                localStorage.setItem('CAMPISTRY_LOCAL_CACHE', String(Date.now()) + ':' + Math.random().toString(36).slice(2, 8));
                try { sessionStorage.removeItem('_campistry_local_write_failed'); } catch (_) {}
                try { localStorage.removeItem('_campistry_local_write_failed'); } catch (_) {}
            } catch (innerE) {
                if (innerE && innerE.name === 'QuotaExceededError') {
                    // Quota fail on the stripped copy is no longer dangerous —
                    // IDB has the full state. Only set the stale-local marker
                    // when IDB is NOT available (pure localStorage mode).
                    if (!window.LocalCacheIDB) {
                        try { sessionStorage.setItem('_campistry_local_write_failed', '1'); } catch (_) {}
                    }
                    log('localStorage quota exceeded for sync-init snapshot — full state is in IDB, safe to ignore');
                } else {
                    throw innerE;
                }
            }

            if (data.divisions || data.bunks) {
                try {
                    localStorage.setItem('campGlobalRegistry_v1', JSON.stringify({
                        divisions: data.divisions || {},
                        bunks: data.bunks || []
                    }));
                } catch (regE) {
                    if (regE && regE.name === 'QuotaExceededError') {
                        log('campGlobalRegistry_v1 write hit quota — skipping (IDB has it)');
                    } else {
                        throw regE;
                    }
                }
            }
        } catch (e) {
            logError('Failed to write local settings:', e);
        }
    }

    function updateLocalSetting(key, value) {
        const current = getLocalSettings();
        current[key] = value;
        current.updated_at = new Date().toISOString();
        setLocalSettings(current);
    }

    // =========================================================================
    // CLOUD SYNC - BATCHED OPERATIONS
    // =========================================================================

    function queueSettingChange(key, value) {
        updateLocalSetting(key, value);
        _pendingChanges[key] = value;
        
        log(`Queued change: ${key}`, typeof value === 'object' && value !== null ?
            (Array.isArray(value) ? `[${value.length} items]` : `{${Object.keys(value).length} keys}`) :
            value);
        
        scheduleBatchSync();
    }

    function scheduleBatchSync() {
        if (_syncTimeout) {
            clearTimeout(_syncTimeout);
        }
        
        _syncTimeout = setTimeout(async () => {
            await executeBatchSync();
        }, CONFIG.SYNC_DEBOUNCE_MS);
    }

    async function executeBatchSync() {
        if (_isSyncing) {
            log('Sync already in progress, rescheduling...');
            scheduleBatchSync();
            return;
        }

        if (Object.keys(_pendingChanges).length === 0) {
            log('No pending changes to sync');
            return;
        }

        // Hold ALL cloud writes until hydration completes. Before hydration,
        // local state is built from IDB/localStorage and may be stale (e.g.
        // empty divisions from a prior quota failure). Writing that stale
        // state to cloud would overwrite good data restored from the old blob.
        if (!_cloudHydrationDone) {
            log('Holding sync until cloud hydration completes');
            setTimeout(() => {
                if (Object.keys(_pendingChanges).length > 0) scheduleBatchSync();
            }, 1000);
            return;
        }

        if (!navigator.onLine) {
            log('Offline — changes held in _pendingChanges, will sync on reconnect');
            // Do NOT clear _pendingChanges — keep them so they sync when back online
            if (!_onlineRetryRegistered) {
                _onlineRetryRegistered = true;
                window.addEventListener('online', function _onlineRetry() {
                    _onlineRetryRegistered = false;
                    window.removeEventListener('online', _onlineRetry);
                    if (Object.keys(_pendingChanges).length > 0) {
                        log('Back online — retrying', Object.keys(_pendingChanges).length, 'pending change(s)');
                        scheduleBatchSync();
                    }
                });
            }
            return;
        }

        const client = window.CampistryDB?.getClient?.();
        const campId = window.CampistryDB?.getCampId?.();

        if (!client || !campId) {
            log('Client/campId not ready — holding changes, will retry shortly');
            // Do NOT clear _pendingChanges — schedule a retry once client initialises
            setTimeout(() => {
                if (Object.keys(_pendingChanges).length > 0) scheduleBatchSync();
            }, 2000);
            return;
        }

        // ★★★ FIX v6.8: EARLY EXIT for non-admin roles ★★★
        // camp_state_kv RLS allows owner/admin to write; schedulers can read
        // but not write. Schedulers/viewers must NOT attempt UPSERT calls
        // or the 403 error propagates up through forceSyncToCloud →
        // saveDailySkeleton → runOptimizer and kills schedule generation.
        if (!_canWriteCampState()) {
            // During boot, role defaults to 'viewer' before auth completes.
            // Don't drop changes yet — retry a few times so owner/admin
            // syncs succeed once auth resolves.
            _roleCheckRetries = (_roleCheckRetries || 0) + 1;
            if (_roleCheckRetries <= 5) {
                log('Skipping camp_state sync — role not yet confirmed, retry', _roleCheckRetries, '/ 5');
                setTimeout(() => {
                    if (Object.keys(_pendingChanges).length > 0) scheduleBatchSync();
                }, 2000);
                return;
            }
            log('Skipping camp_state sync — role cannot access camp_state table (changes saved locally)');
            _pendingChanges = {};
            _lastSyncTime = Date.now();
            return;
        }
        _roleCheckRetries = 0;

        _isSyncing = true;
        const changesToSync = { ..._pendingChanges };
        _pendingChanges = {};

        try {
            const keys = Object.keys(changesToSync).filter(k => k !== 'updated_at');
            log('Executing batch sync:', keys);

            // ═══════════════════════════════════════════════════════════════
            // Per-key UPSERT into camp_state_kv. Each (camp_id, key) is its
            // own row, so multiple writers (Me, Flow, daily_adjustments, etc.)
            // cannot clobber each other's TOP-LEVEL keys.
            //
            // ★ Special case for `app1`: it is the one top-level key with
            //   genuine multi-writer ownership of its sub-keys (Me owns
            //   camperRoster, Flow owns bunks/divisions/specialActivities/
            //   bunkMetaData, daily_adjustments owns dailySkeletons, etc.).
            //   A wholesale replacement of the app1 row would let one writer's
            //   partial payload silently drop another writer's sub-keys.
            //   Fetch the current cloud value and shallow-merge before upsert.
            //   For every other key, replacement is correct.
            // ═══════════════════════════════════════════════════════════════
            const nowIso = new Date().toISOString();

            // Fetch-merge for keys with multi-writer sub-key ownership.
            // The lite localStorage snapshot strips heavy sub-keys
            // (camperRoster on app1; families/enrollments/payments/finance/
            // bunkAssignments on campistryMe) so a writer reading from
            // localStorage and pushing the result wholesale would
            // silently delete those sub-keys from cloud.
            const FETCH_MERGE_KEYS = ['app1', 'campistryMe'];
            for (const mergeKey of FETCH_MERGE_KEYS) {
                if (keys.includes(mergeKey) &&
                    changesToSync[mergeKey] &&
                    typeof changesToSync[mergeKey] === 'object' &&
                    !Array.isArray(changesToSync[mergeKey])) {
                    try {
                        const { data: cur, error: curErr } = await client
                            .from('camp_state_kv')
                            .select('value')
                            .eq('camp_id', campId)
                            .eq('key', mergeKey)
                            .maybeSingle();
                        if (!curErr && cur && cur.value && typeof cur.value === 'object') {
                            changesToSync[mergeKey] = { ...cur.value, ...changesToSync[mergeKey] };
                        }
                    } catch (mergeErr) {
                        log(`${mergeKey} fetch-merge failed (will replace wholesale):`, mergeErr?.message || mergeErr);
                    }
                }
            }

            const rows = keys.map(k => ({
                camp_id:    campId,
                key:        k,
                value:      changesToSync[k] ?? null,
                updated_at: nowIso
            }));

            if (rows.length === 0) {
                _isSyncing = false;
                return;
            }

            // Mark self-write BEFORE the upsert resolves. Postgres replicates
            // the change to the realtime stream as soon as the transaction
            // commits — sometimes that arrives at our subscriber before the
            // client gets the response, causing the echo-suppression check
            // to miss and triggering a redundant re-hydrate.
            _lastSelfWriteAt = Date.now();

            // Cache the access token while we have a fresh async context.
            // The beforeunload handler (which runs synchronously) needs a
            // token to send a fetch-keepalive upsert; without this it can
            // only fire-and-forget through supabase-js, which doesn't set
            // keepalive: true and so dies with the tab.
            //
            // Slice 2 audit fix: only cache tokens that won't expire in
            // the next 60s. Earlier the cached token could be ~1h stale
            // by the time beforeunload fired, returning 401 silently
            // while the optimistic _pendingChanges clear ran anyway.
            try {
                const sess = await client.auth.getSession();
                const tok = sess?.data?.session?.access_token;
                const expSec = sess?.data?.session?.expires_at;
                if (tok && (!expSec || (expSec * 1000 - Date.now()) > 60000)) {
                    _cachedAccessToken = tok;
                } else {
                    _cachedAccessToken = null;
                }
            } catch (_) {}

            const { error: upsertError } = await client
                .from('camp_state_kv')
                .upsert(rows, { onConflict: 'camp_id,key' });

            if (upsertError) {
                logError('Failed to sync to cloud (camp_state_kv):', upsertError);
                throw upsertError;
            }

            // Refresh the timestamp post-resolve so the suppression window
            // covers replication delay both ways.
            _lastSelfWriteAt = Date.now();

            _lastSyncTime = Date.now();

            console.log('☁️ Cloud sync complete:', {
                keys,
                rows: rows.length
            });

            window.dispatchEvent(new CustomEvent('campistry-settings-synced', {
                detail: { keys }
            }));

        } catch (e) {
            logError('Batch sync failed:', e);
            // Restore failed keys WITHOUT clobbering newer pending values.
            // Earlier this used Object.assign(_pendingChanges, changesToSync)
            // which overwrote a fresh edit (queued during the failed sync)
            // with the older retry value — silent edit loss.
            for (const k of Object.keys(changesToSync)) {
                if (!(k in _pendingChanges)) _pendingChanges[k] = changesToSync[k];
            }

            window.dispatchEvent(new CustomEvent('campistry-sync-error', {
                detail: { error: e.message, keys: Object.keys(changesToSync) }
            }));
        } finally {
            _isSyncing = false;
        }
    }

    async function forceSyncToCloud() {
        log('Force sync requested');

        if (_syncTimeout) {
            clearTimeout(_syncTimeout);
            _syncTimeout = null;
        }

        if (!_cloudHydrationDone) {
            log('Force sync deferred — waiting for cloud hydration');
            return true;
        }

        // ★★★ FIX v6.8: Don't even queue if scheduler ★★★
        if (!_canWriteCampState()) {
            log('Force sync skipped — role not confirmed yet or cannot write camp_state');
            return true;
        }

        // _localCache is already up-to-date: all callers go through
        // saveGlobalSettings → updateLocalSetting → setLocalSettings,
        // which writes to _localCache, IDB, AND localStorage.  Nullifying
        // _localCache here forces getLocalSettings() to fall back to the
        // STRIPPED localStorage snapshot (which intentionally omits heavy
        // keys like camperRoster, families, enrollments).  That re-read
        // then becomes the new _localCache — permanently losing those keys
        // until the next cloud hydration restores them.
        const localSettings = getLocalSettings();
        const allChanges = { ...localSettings, ..._pendingChanges };
        _pendingChanges = allChanges;

        await executeBatchSync();

        return true;
    }

    // =========================================================================
    // VERIFIED SCHEDULE SAVE (WITH RETRY AND DEDUPLICATION)
    // =========================================================================

    async function verifiedScheduleSave(dateKey, data, attempt = 1) {
        if (!dateKey) dateKey = window.currentScheduleDate;
        if (!data) {
            // ★★★ CROSS-DATE CORRUPTION GUARD (lazy build) ★★★
            // Building the payload from window.scheduleAssignments is only safe
            // when the in-memory schedule actually BELONGS to dateKey. The owner
            // stamp (window._scheduleAssignmentsDate) is kept atomic with every
            // schedule data write (date-change load, cloud hydrate, realtime
            // merge, generation). If it disagrees with dateKey, a concurrent
            // navigation / hydrate has swapped another day's schedule into
            // memory — serializing THAT under dateKey would silently corrupt the
            // cloud row (the exact bug this guards). Refuse instead. Inert when
            // the stamp is unset (degrades to prior behavior). The next
            // coherent save on the real owner date persists normally.
            const _owner = window._scheduleAssignmentsDate;
            if (_owner && dateKey && _owner !== dateKey) {
                console.warn('[VERIFIED SAVE] ★ REFUSED lazy save: in-memory schedule belongs to ' +
                             _owner + ' but target is ' + dateKey + ' — preventing cross-date corruption');
                return { success: false, skipped: 'owner-mismatch', target: 'skipped' };
            }
            // ★ FIX: include _perBunkSlotsData + manualSkeleton + _autoGenerated.
            //   Without these, the auto-build's per-bunk geometry was stripped
            //   from the cloud row on every post-generation save. On reload,
            //   cloud hydration overwrote local — fixAllBunkSlotCounts then
            //   trimmed scheduleAssignments to a smaller skeleton-rebuilt
            //   length, leaving "+ Add" gaps where Sports/Specials had been
            //   placed. Earlier commit 7b08216e wrote these keys at Step 5
            //   but verifiedScheduleSave (called next via the schedule-saved
            //   hook) silently undid that write.
            const _spbs = {};
            const _dt = window.divisionTimes || {};
            Object.keys(_dt).forEach(g => {
                if (_dt[g]?._perBunkSlots) _spbs[g] = _dt[g]._perBunkSlots;
            });
            data = {
                scheduleAssignments: window.scheduleAssignments || {},
                leagueAssignments: window.leagueAssignments || {},
                unifiedTimes: window.unifiedTimes || [],
                divisionTimes: window.DivisionTimesSystem?.serialize?.(window.divisionTimes) || _dt,
                isRainyDay: window.isRainyDay || false,
                rainyDayStartTime: window.rainyDayStartTime ?? null,
                rainyDayMode: window.isRainyDay || false  // backward compatibility
            };
            if (Object.keys(_spbs).length > 0) data._perBunkSlotsData = _spbs;
            if (window._autoSkeleton) data.manualSkeleton = window._autoSkeleton;
            if (window.dailyOverrideSkeleton && Array.isArray(window.dailyOverrideSkeleton) && window.dailyOverrideSkeleton.length > 0) {
                data.manualSkeleton = data.manualSkeleton || window.dailyOverrideSkeleton;
            }
            // Forward _autoGenerated flag if present in the localStorage row so
            //   load path picks the auto-mode rebuild branch.
            try {
                const _lsRow = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}')[dateKey];
                if (_lsRow?._autoGenerated) data._autoGenerated = true;
            } catch (_) {}
            // Bind the payload to its owner date so ScheduleDB.saveSchedule's
            // authoritative guard can confirm it (we proved _owner===dateKey above).
            data._belongsToDate = dateKey;
        }

        const bunkCount = Object.keys(data.scheduleAssignments || {}).length;

        // ★★★ v6.4: Deduplication check - skip if same save within threshold ★★★
        // ★ Day 24 fix: dedup must key on CONTENT, not just bunk count. A
        //   post-gen recapture or post-edit can produce a different schedule
        //   with the same bunk count, and the original (now stale) version
        //   would be all that ever reached cloud. Use a fast content hash so
        //   only truly identical payloads dedup.
        const now = Date.now();
        let _saveHash = 0;
        try {
            const _s = JSON.stringify(data.scheduleAssignments || {}) + '|' + JSON.stringify(data.leagueAssignments || {});
            for (let _i = 0; _i < _s.length; _i++) {
                _saveHash = ((_saveHash << 5) - _saveHash + _s.charCodeAt(_i)) | 0;
            }
        } catch (_) { _saveHash = now; }
        const saveKey = `${dateKey}:${bunkCount}:${_saveHash}`;

        if (attempt === 1) {  // Only check dedup on first attempt, not retries
            if (_saveInProgress) {
                log('[VERIFIED SAVE] Save already in progress, skipping duplicate');
                return { success: true, target: 'deduplicated', reason: 'in-progress' };
            }

            if (_lastSaveKey === saveKey && (now - _lastSaveTime) < SAVE_DEDUP_MS) {
                log('[VERIFIED SAVE] Duplicate save detected (identical content), skipping');
                return { success: true, target: 'deduplicated', reason: 'recent-duplicate' };
            }

            _saveInProgress = true;
            _lastSaveKey = saveKey;
            _lastSaveTime = now;
        }

        // try/finally guarantees _saveInProgress is cleared once the outermost
        // call returns. Earlier code only cleared the flag at retry exhaustion,
        // so the ScheduleDB-not-ready / auth-not-ready retry paths held the
        // flag set across the 2s sleep — blocking concurrent saves.
        try {
            log(`[VERIFIED SAVE] Attempt ${attempt}/${CONFIG.SAVE_MAX_RETRIES} - ${bunkCount} bunks for ${dateKey}`);

            if (bunkCount === 0) {
                log('[VERIFIED SAVE] No data to save');
                return { success: true, target: 'empty' };
            }

            // ★★★ NEW: Check if online ★★★
            if (!navigator.onLine) {
                log('[VERIFIED SAVE] Offline - saved to localStorage only');
                showNotification('📴 Saved locally (offline)', 'warning');

                // Queue for later via ScheduleSync if available
                if (window.ScheduleSync?.queueSave) {
                    window.ScheduleSync.queueSave(dateKey, data);
                }

                return { success: true, target: 'localStorage', offline: true };
            }

            if (!window.ScheduleDB?.saveSchedule) {
                log('[VERIFIED SAVE] ScheduleDB not ready, waiting...');
                if (attempt < CONFIG.SAVE_MAX_RETRIES) {
                    await new Promise(r => setTimeout(r, CONFIG.SAVE_RETRY_DELAY_MS));
                    return await verifiedScheduleSave(dateKey, data, attempt + 1);
                }
                logError('[VERIFIED SAVE] ScheduleDB never became available');
                return { success: false, error: 'ScheduleDB not available' };
            }

            const campId = window.CampistryDB?.getCampId?.();
            const userId = window.CampistryDB?.getUserId?.();

            if (!campId || !userId) {
                log('[VERIFIED SAVE] Auth not ready, waiting...');
                if (attempt < CONFIG.SAVE_MAX_RETRIES) {
                    await new Promise(r => setTimeout(r, CONFIG.SAVE_RETRY_DELAY_MS));
                    return await verifiedScheduleSave(dateKey, data, attempt + 1);
                }
                logError('[VERIFIED SAVE] Auth never became available');
                return { success: false, error: 'Missing authentication' };
            }

            try {
                const result = await window.ScheduleDB.saveSchedule(dateKey, data);

                // ★★★ STARTER PLAN: Do NOT retry plan-limit blocks ★★★
                if (result?.target === 'plan-limit') {
                    log('[VERIFIED SAVE] Blocked by plan limit:', result.error?.message || result.error);
                    showNotification(result.error?.message || 'Schedule limit reached. Upgrade for unlimited.', 'warning');
                    return result;
                }

                // 'cloud-unverified' = upsert succeeded but the post-save
                // SELECT didn't see the row yet (Supabase replication
                // delay). The data IS in the cloud — retrying would just
                // re-stamp rotation history / re-rebuild historicalCounts
                // on every save.
                if (result?.success && (result?.target === 'cloud' || result?.target === 'cloud-verified' || result?.target === 'cloud-unverified')) {
                    log('✅ Schedule saved to cloud:', bunkCount, 'bunks', result?.target === 'cloud-unverified' ? '(unverified)' : '');
                    showNotification(`Saved ${bunkCount} bunks`, 'success');
                    return result;
                } else if (result?.target === 'local' || result?.target === 'local-fallback') {
                    console.warn('🔗 ⚠️ Schedule saved to LOCAL only, retrying cloud...');
                    if (attempt < CONFIG.SAVE_MAX_RETRIES) {
                        await new Promise(r => setTimeout(r, CONFIG.SAVE_RETRY_DELAY_MS));
                        return await verifiedScheduleSave(dateKey, data, attempt + 1);
                    }
                    showNotification('Saved locally (offline)', 'warning');
                    return result;
                } else {
                    logError('[VERIFIED SAVE] Save failed:', result?.error);
                    if (attempt < CONFIG.SAVE_MAX_RETRIES) {
                        await new Promise(r => setTimeout(r, CONFIG.SAVE_RETRY_DELAY_MS));
                        return await verifiedScheduleSave(dateKey, data, attempt + 1);
                    }
                    showNotification('Save failed', 'error');
                    return result;
                }
            } catch (e) {
                // ★★★ STARTER PLAN: Detect trigger rejection — do NOT retry ★★★
                if ((e.message && e.message.includes('Starter plan limit')) || e.code === 'P0001') {
                    showNotification('Starter plan limit reached. Upgrade for unlimited access.', 'warning');
                    return { success: false, error: e.message, target: 'plan-limit' };
                }
                logError('[VERIFIED SAVE] Exception:', e);
                if (attempt < CONFIG.SAVE_MAX_RETRIES) {
                    await new Promise(r => setTimeout(r, CONFIG.SAVE_RETRY_DELAY_MS));
                    return await verifiedScheduleSave(dateKey, data, attempt + 1);
                }
                showNotification('Save error', 'error');
                return { success: false, error: e.message };
            }
        } finally {
            // Only the outermost call (attempt === 1) clears the flag —
            // recursive retries inherit the same flag state.
            if (attempt === 1) _saveInProgress = false;
        }
    }

    // =========================================================================
    // FORCE LOAD FROM CLOUD
    // =========================================================================

    // Reconcile scheduleAssignments against the current activity registry.
    // If Device A deleted "Soccer" while Device B saved a row that still
    // referenced it, the cloud row brings the orphan name back; without
    // this, "+ Add" gaps render where the deleted activity used to live.
    function reconcileOrphanActivities() {
        try {
            if (!window.scheduleAssignments) return 0;
            const validNames = new Set();
            try {
                const settings = window.loadGlobalSettings?.() || {};
                const app1 = settings.app1 || {};
                (app1.fields || []).forEach(f => (f.activities || []).forEach(a => a && validNames.add(a)));
                (app1.specialActivities || []).forEach(s => s?.name && validNames.add(s.name));
                (settings.specialActivities || []).forEach(s => s?.name && validNames.add(s.name));
                (settings.facilities || []).forEach(fac => {
                    (fac.activities || []).forEach(a => a && validNames.add(a));
                    (fac.specialActivityNames || []).forEach(n => n && validNames.add(n));
                    (fac.generalActivities || []).forEach(ga => {
                        const n = (ga && ga.name) || ga;
                        if (n) validNames.add(n);
                    });
                });
                (settings.allSports || []).forEach(s => {
                    const n = typeof s === 'string' ? s : s?.name;
                    if (n) validNames.add(n);
                });
            } catch (_) {}
            // System slot types — never treat as orphans.
            ['Free', 'Lunch', 'Snack', 'Snacks', 'Dismissal',
             'Swim', 'Pool', 'League Game',
             'Transition/Buffer', 'Transition', 'Buffer',
             'Lineup', 'Regroup', 'Bus'].forEach(n => validNames.add(n));

            // Empty registry -> bail rather than nuke everything (registry
            // probably hasn't loaded yet).
            if (validNames.size === 0) return 0;

            let nulled = 0;
            Object.keys(window.scheduleAssignments).forEach(bunk => {
                const slots = window.scheduleAssignments[bunk];
                if (!Array.isArray(slots)) return;
                slots.forEach((slot, i) => {
                    if (!slot || typeof slot !== 'object') return;
                    // Skip legitimate non-registry slot types — leagues
                    // write `_activity: 'League: <name>'`; transitions and
                    // continuation cells carry their own type markers.
                    if (slot._isTransition || slot._league || slot.continuation) return;
                    const name = slot._activity || slot.activity || slot.event;
                    if (typeof name === 'string' && name.startsWith('League:')) return;
                    if (name && !validNames.has(name)) {
                        slots[i] = null;
                        nulled++;
                    }
                });
            });
            if (nulled > 0) {
                console.log('[ORPHAN RECONCILE] Cleared', nulled, 'orphan slot(s) — activity no longer in registry');
            }
            return nulled;
        } catch (e) {
            logError('[ORPHAN RECONCILE] failed:', e);
            return 0;
        }
    }
    window.reconcileOrphanActivities = reconcileOrphanActivities;

    async function forceLoadScheduleFromCloud(dateKey) {
        if (!dateKey) dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        
        log('[CLOUD LOAD] Force loading schedule for:', dateKey);

        if (!window.ScheduleDB?.loadSchedule) {
            log('[CLOUD LOAD] ScheduleDB not available');
            return { success: false, error: 'ScheduleDB not available' };
        }

        try {
            const result = await window.ScheduleDB.loadSchedule(dateKey);
            
            if (result?.success && result.data) {
                const bunkCount = Object.keys(result.data.scheduleAssignments || {}).length;
                log(`[CLOUD LOAD] Loaded ${bunkCount} bunks from ${result.source}`);
                
                // Hydrate window globals
                if (result.data.scheduleAssignments) {
                    window.scheduleAssignments = result.data.scheduleAssignments;
                }
                if (result.data.leagueAssignments) {
                    window.leagueAssignments = result.data.leagueAssignments;
                }
                // ★★★ CROSS-DATE GUARD: keep the date stamp coherent with the data we just
                // hydrated. Without this, force-loading a date other than the current one
                // leaves window.scheduleAssignments holding dateKey's data while the stamp
                // still names the old date — a save would then write dateKey's data under
                // the wrong key (the stamp would falsely "match"). Stamp it to dateKey so
                // the cross-date save guard stays accurate.
                window._scheduleAssignmentsDate = dateKey;
                
                // ★★★ FIX: Properly hydrate unifiedTimes ★★★
                if (result.data.unifiedTimes?.length > 0) {
                    window.unifiedTimes = result.data.unifiedTimes;
                    log('[CLOUD LOAD] Hydrated unifiedTimes:', window.unifiedTimes.length, 'slots');
                }
                
                if (result.data.divisionTimes) {
                    window.divisionTimes = result.data.divisionTimes;
                }

                // ★★★ FIX v6.5: Hydrate rainy day state ★★★
                if (result.data.isRainyDay === true || result.data.rainyDayMode === true) {
                    window.isRainyDay = true;
                    log('[CLOUD LOAD] Hydrated isRainyDay: true');
                } else if (result.data.isRainyDay === false) {
                    window.isRainyDay = false;
                    log('[CLOUD LOAD] Hydrated isRainyDay: false');
                }
                
                if (result.data.rainyDayStartTime !== null && result.data.rainyDayStartTime !== undefined) {
                    window.rainyDayStartTime = result.data.rainyDayStartTime;
                    log('[CLOUD LOAD] Hydrated rainyDayStartTime:', result.data.rainyDayStartTime);
                } else {
                    window.rainyDayStartTime = null;
                }

                // Update localStorage
                const DAILY_KEY = 'campDailyData_v1';
                try {
                    const allData = JSON.parse(localStorage.getItem(DAILY_KEY) || '{}');
                    allData[dateKey] = result.data;
                    localStorage.setItem(DAILY_KEY, JSON.stringify(allData));
                } catch (e) { /* ignore */ }

                // Strip orphan-activity references that another device may
                // have saved to cloud after this device deleted the activity.
                // Run BEFORE updateTable so the render reflects the cleaned
                // state — running after leaves stale "+ Add" cells visible
                // until the next user-triggered re-render.
                reconcileOrphanActivities();

                // Refresh UI
                if (window.updateTable) {
                    window.updateTable();
                }

                console.log('🔗 ✅ Schedule loaded from cloud:', bunkCount, 'bunks');
                if (window.SchedulerCoreUtils?.hydrateLocalStorageFromCloud) {
                    console.log('🔗 Hydrating localStorage with all cloud schedule dates...');
                    window.SchedulerCoreUtils.hydrateLocalStorageFromCloud().then(ok => {
                        if (ok) console.log('🔗 ✅ localStorage hydrated with cloud history');
                    });
                }
                return result;
            } else {
                log('[CLOUD LOAD] No cloud data found');
                return { success: true, source: 'empty', data: null };
            }
        } catch (e) {
            logError('[CLOUD LOAD] Exception:', e);
            return { success: false, error: e.message };
        }
    }

    // =========================================================================
    // SINGLE AUTHORITATIVE saveGlobalSettings HANDLER
    // =========================================================================

    /**
     * ★★★ SINGLE AUTHORITATIVE HANDLER — v6.6 MULTI-DATE FIX ★★★
     * This replaces all other patches. Do NOT patch this function elsewhere.
     *
     * CRITICAL FIX (v6.6): When key === 'daily_schedules', callers pass the FULL
     * campDailyData_v1 object containing ALL dates. Previous versions only saved
     * ONE arbitrary date (Object.keys(data)[0]), silently dropping all others.
     *
     * Affected callers that were losing data:
     *   - calendar.js saveCurrentDailyData() — only current date synced
     *   - fields.js cleanupDeletedField/propagateFieldRename — multi-date cleanup lost
     *   - special_activities.js cleanup/rename — multi-date cleanup lost
     *   - scheduler_core_leagues.js updateFutureSchedules — future dates lost
     *   - scheduler_core_specialty_leagues.js updateFutureSchedules — future dates lost
     *
     * Now we:
     *   1. ALWAYS persist full object to localStorage (was missing entirely!)
     *   2. Cloud-sync the CURRENT date via verifiedScheduleSave (with retry)
     *   3. Cloud-sync ALL OTHER dates via lightweight ScheduleDB.saveSchedule
     */
    // ★ Coalesce rapid-fire daily_schedules saves. Calendar's "Bridge
    // (Unified Flow)" path fires saveGlobalSettings 4× per generation
    // with the same data — skip if we just processed an identical payload
    // in the last 750ms. Cuts 3 of every 4 redundant log + hash passes.
    let _lastDailySchedulesCallAt = 0;
    let _lastDailySchedulesHash = null;
    function _quickHashAllDaily(d) {
        // djb2 over the full payload. Earlier this was payload-length +
        // key count, which collided on equal-length edits (e.g. renaming
        // an activity "Soccer" → "Hockey") and silently dropped the save
        // inside the 750ms dedupe window.
        try {
            const s = JSON.stringify(d || {});
            let h = 5381;
            for (let i = 0; i < s.length; i++) {
                h = ((h << 5) + h + s.charCodeAt(i)) | 0;
            }
            return h;
        } catch (_) { return Math.random(); }
    }
    window.saveGlobalSettings = function(key, data) {
        // For daily_schedules, persist locally AND sync ALL dates to cloud
        if (key === 'daily_schedules') {
            const _nowDbg = Date.now();
            const _hDbg = _quickHashAllDaily(data);
            if (_hDbg === _lastDailySchedulesHash && (_nowDbg - _lastDailySchedulesCallAt) < 750) {
                return true; // duplicate burst — already handled
            }
            _lastDailySchedulesCallAt = _nowDbg;
            _lastDailySchedulesHash = _hDbg;

            // ═══════════════════════════════════════════════════════════════
            // STEP 1: Always persist full object to localStorage
            // (Previously missing! The handler returned true without saving.)
            // ═══════════════════════════════════════════════════════════════
            try {
                // ★ #V2-1: PROACTIVE date cap. Previously campDailyData_v1 grew UNBOUNDED
                //   (every date ever) and only pruned REACTIVELY to 3 dates once a
                //   QuotaExceededError fired — by which point localStorage was already at
                //   ~143% and auto-save had been silently skipping. Cap a COPY to the most
                //   recent ~45 dates (>6 weeks — covers the rotation month-window) so it
                //   stays bounded; the in-memory `data` and the cloud-bound payload keep
                //   every date (cloud is per-date, so dropping old dates from the LOCAL
                //   mirror is lossless).
                let _lsWrite = data;
                try {
                    const _DRE = /^\d{4}-\d{2}-\d{2}$/;
                    const _dk = Object.keys(data).filter(k => _DRE.test(k));
                    if (_dk.length > 45) {
                        _dk.sort();
                        _lsWrite = Object.assign({}, data);
                        _dk.slice(0, _dk.length - 45).forEach(k => { delete _lsWrite[k]; });
                    }
                } catch (_) { _lsWrite = data; }
                localStorage.setItem('campDailyData_v1', JSON.stringify(_lsWrite));
            } catch (e) {
                if (e.name === 'QuotaExceededError') {
                    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
                    const lsData = JSON.parse(JSON.stringify(data));
                    const lsDateKeys = Object.keys(lsData).filter(k => DATE_RE.test(k)).sort();
                    let pruneSucceeded = false;
                    while (lsDateKeys.length > 3) {
                        delete lsData[lsDateKeys.shift()];
                        try {
                            localStorage.setItem('campDailyData_v1', JSON.stringify(lsData));
                            pruneSucceeded = true;
                            break;
                        }
                        catch (_) { /* keep pruning */ }
                    }
                    // If even 3 dates couldn't fit (or no prune iterations ran),
                    // localStorage is silently stale. Set the marker so the
                    // next hydration prefers cloud over local — without this,
                    // very large camps could trust a stale local snapshot.
                    if (!pruneSucceeded) {
                        try { sessionStorage.setItem('_campistry_local_write_failed', '1'); } catch (_) {}
                        try { localStorage.setItem('_campistry_local_write_failed', '1'); } catch (_) {}
                        logError('[saveGlobalSettings] daily_schedules localStorage write exhausted prune budget');
                    }
                } else {
                    logError('[saveGlobalSettings] localStorage write failed:', e);
                }
            }

            // ═══════════════════════════════════════════════════════════════
            // STEP 2: Collect ALL valid date keys (filter out 'updated_at'
            // and any other non-date root keys that calendar.js may add)
            // ═══════════════════════════════════════════════════════════════
            const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
            const allDateKeys = Object.keys(data).filter(k =>
                DATE_REGEX.test(k) && data[k] && typeof data[k] === 'object'
            );

            if (allDateKeys.length === 0) {
                log('[saveGlobalSettings] daily_schedules: no valid date keys found');
                return true;
            }

            // ═══════════════════════════════════════════════════════════════
            // STEP 3: Determine the primary (current) date
            // ═══════════════════════════════════════════════════════════════
            const currentDate = window.currentScheduleDate ||
                                document.getElementById('schedule-date-input')?.value ||
                                document.getElementById('datepicker')?.value;

            const primaryDateKey = allDateKeys.includes(currentDate)
                ? currentDate
                : allDateKeys.find(k => data[k]?.scheduleAssignments) || allDateKeys[0];

            // ═══════════════════════════════════════════════════════════════
            // STEP 4: Save PRIMARY date with verified save (retry + verify)
            // Deduplicate: skip if this date was already saved within 30s
            // ═══════════════════════════════════════════════════════════════
            if (!window._secondarySaveLog) window._secondarySaveLog = {};
            const now = Date.now();

            if (primaryDateKey && data[primaryDateKey]) {
                const lastPrimarySave = window._secondarySaveLog[primaryDateKey] || 0;
                if ((now - lastPrimarySave) > 30000) {
                    window._secondarySaveLog[primaryDateKey] = now;
                    verifiedScheduleSave(primaryDateKey, data[primaryDateKey])
                        .then(result => {
                            if (!result?.success) {
                                console.warn('🔗 Primary schedule save issue:', result?.error);
                            }
                        })
                        .catch(e => logError('Primary schedule save failed:', e));
                }
            }

            // ═══════════════════════════════════════════════════════════════
            // STEP 5: Save OTHER dates via lightweight ScheduleDB.saveSchedule
            // These are dates modified by propagation (field rename/delete,
            // activity rename/delete, league future-date updates, etc.)
            // Uses skipFilter:true since propagation changes affect all bunks.
            // Staggered 500ms apart to avoid hammering the cloud.
            //
            // ★ Hash-gated: we only fan out a save when the date's
            // scheduleAssignments JSON differs from the last hash we sent.
            // Without this, every generation would re-save 14 days of
            // hydrated rotation history that hadn't actually changed.
            // ═══════════════════════════════════════════════════════════════
            if (!window._secondarySaveHash) window._secondarySaveHash = {};
            // Delegate to the module-scoped hasher so seeded baselines
            // (set by _seedSecondarySaveHashes during hydration) are
            // comparable with the hashes computed here.
            const _hashDateData = _hashDateDataModule;

            const secondaryDateKeys = allDateKeys.filter(k =>
                k !== primaryDateKey &&
                data[k]?.scheduleAssignments &&
                Object.keys(data[k].scheduleAssignments).length > 0
            );

            if (secondaryDateKeys.length > 0 && window.ScheduleDB?.saveSchedule) {
                // Drop dates whose content hash matches what we last sent —
                // those dates are unchanged and don't need a cloud round-trip.
                // Also keep the existing 30s timestamp dedupe as a safety net.
                const unsaved = secondaryDateKeys.filter(dk => {
                    const hash = _hashDateData(data[dk]);
                    if (window._secondarySaveHash[dk] === hash) return false;
                    if (window._secondarySaveLog[dk] && (now - window._secondarySaveLog[dk]) <= 30000) return false;
                    return true;
                });

                if (unsaved.length > 0) {
                    log(`[saveGlobalSettings] Syncing ${unsaved.length} secondary date(s) to cloud (skipped ${secondaryDateKeys.length - unsaved.length} unchanged)`);
                    // Stamp hash optimistically so duplicate calls inside the
                    // same burst dedupe correctly. _secondarySaveLog (the 30s
                    // suppress-window) is stamped only on success below — so
                    // a transient failure doesn't block the next retry.
                    unsaved.forEach(dk => {
                        window._secondarySaveHash[dk] = _hashDateData(data[dk]);
                    });

                    unsaved.forEach((dk, index) => {
                        setTimeout(() => {
                            window.ScheduleDB.saveSchedule(dk, data[dk], { skipFilter: true, allowCrossDate: true })
                                .then(r => {
                                    if (r?.success) {
                                        window._secondarySaveLog[dk] = Date.now();
                                        log(`  ✅ Secondary save: ${dk}`);
                                    } else {
                                        // Drop the hash too — next call should retry.
                                        delete window._secondarySaveHash[dk];
                                        console.warn(`  ⚠️ Secondary save failed: ${dk}`, r?.error);
                                    }
                                })
                                .catch(e => {
                                    delete window._secondarySaveHash[dk];
                                    console.warn(`  ⚠️ Secondary save error: ${dk}`, e.message);
                                });
                        }, (index + 1) * 500);
                    });
                } else if (secondaryDateKeys.length > 0) {
                    log(`[saveGlobalSettings] Skipped ${secondaryDateKeys.length} unchanged secondary date(s)`);
                }
            }

            return true;
        }
        
        // All other settings go through batched sync
        queueSettingChange(key, data);
        
        return true;
    };

    // Mark as the authoritative handler so other code doesn't re-patch
    window.saveGlobalSettings._isAuthoritativeHandler = true;

    /**
     * loadGlobalSettings - Load settings (from cache or cloud)
     */
    window.loadGlobalSettings = function(key) {
        const settings = getLocalSettings();
        
        if (key) {
            return settings[key] ?? settings.app1?.[key] ?? {};
        }
        
        return settings;
    };

    window.forceSyncToCloud = forceSyncToCloud;

    window.setCloudState = async function(newState, force = false) {
        log('setCloudState called', force ? '(forced)' : '');
        
        setLocalSettings(newState);
        
        Object.keys(newState).forEach(key => {
            _pendingChanges[key] = newState[key];
        });
        
        if (force) {
            await forceSyncToCloud();
        } else {
            scheduleBatchSync();
        }
        
        return true;
    };

    window.resetCloudState = async function() {
        log('resetCloudState called');

        const emptyState = {
            divisions: {},
            bunks: [],
            app1: {
                divisions: {}, bunks: [], fields: [], specialActivities: [],
                allSports: [], bunkMetaData: {}, sportMetaData: {},
                savedSkeletons: {}, skeletonAssignments: {}
            },
            locationZones: {},
            pinnedTileDefaults: {},
            leaguesByName: {},
            leagueRoundState: {},
            leagueHistory: {},
            specialtyLeagueHistory: {},
            daily_schedules: {},
            updated_at: new Date().toISOString()
        };

        setLocalSettings(emptyState);
        _pendingChanges = emptyState;

        // Also wipe the IDB cache and the legacy camp_state row so an
        // "erase all" really erases everything, not just the keys we
        // explicitly empty above.
        if (window.LocalCacheIDB) {
            try { await window.LocalCacheIDB.clear(); } catch (_) {}
        }
        try {
            const client = window.CampistryDB?.getClient?.();
            const campId = window.CampistryDB?.getCampId?.();
            if (client && campId) {
                // Best-effort: remove all KV rows AND the legacy blob row.
                await client.from('camp_state_kv').delete().eq('camp_id', campId);
                await client.from('camp_state').delete().eq('camp_id', campId);
            }
        } catch (e) {
            log('resetCloudState cloud-delete failed (non-fatal):', e?.message || e);
        }

        await forceSyncToCloud();

        // Reset listener flags so the post-reset hydration cycle (whether
        // via explicit reload or programmatic re-hydrate) re-fires the
        // schedule-load and orphan-reconcile passes. Earlier these flags
        // stayed true forever, leaving the post-reset state coupled to
        // the caller doing window.location.reload().
        _scheduleCloudLoadDone = false;
        _cloudHydrationDone = false;

        return true;
    };

    window.clearCloudKeys = async function(keys) {
        log('clearCloudKeys called:', keys);
        
        const settings = getLocalSettings();
        keys.forEach(key => {
            settings[key] = key === 'daily_schedules' ? {} : 
                           key === 'bunks' ? [] : {};
            _pendingChanges[key] = settings[key];
        });
        
        setLocalSettings(settings);
        await forceSyncToCloud();
        
        return true;
    };

    // =========================================================================
    // CLOUD HYDRATION ON STARTUP
    // =========================================================================

    // Lightweight hash of cloud KV rows — used to detect whether cloud data
    // actually changed since the last hydration. Avoids redundant dispatches
    // when the Supabase realtime subscription echoes our own writes.
    function _kvRowsHash(kvRows) {
        if (!Array.isArray(kvRows) || kvRows.length === 0) return 'empty';
        // Combine key + updated_at for each row — cheap and collision-resistant
        // enough for duplicate detection (we don't need crypto strength).
        return kvRows.map(r => r.key + ':' + (r.updated_at || '')).sort().join('|');
    }

    // Dispatch `campistry-cloud-hydrated` with throttle + dedup guards.
    // First dispatch (initial hydration) always goes through.
    // Subsequent dispatches are throttled to once per HYDRATION_THROTTLE_MS.
    function _dispatchHydrated() {
        const now = Date.now();
        // First hydration must always fire (unblocks sync system).
        if (_lastHydrationDispatchAt > 0 && now - _lastHydrationDispatchAt < HYDRATION_THROTTLE_MS) {
            log('campistry-cloud-hydrated throttled (' + (now - _lastHydrationDispatchAt) + 'ms since last)');
            return;
        }
        _lastHydrationDispatchAt = now;
        window.dispatchEvent(new CustomEvent('campistry-cloud-hydrated'));
    }

    async function hydrateFromCloud() {
        const client = window.CampistryDB?.getClient?.();
        const campId = window.CampistryDB?.getCampId?.();

        if (!client || !campId) {
            log('No client/camp ID for hydration');
            _cloudHydrationDone = true;
            return;
        }

        try {
            log('Hydrating from cloud...');

            // ═══════════════════════════════════════════════════════════════
            // Primary: read camp_state_kv (per-key rows). Reconstruct a flat
            // state object from the rows.
            // Fallback: if camp_state_kv is empty for this camp (migration
            // hasn't run yet, or running old code against pre-migration DB),
            // read the legacy camp_state.state blob.
            // ═══════════════════════════════════════════════════════════════
            let cloudState = null;
            let cloudUpdatedAt = null;
            let usedFallback = false;

            const { data: kvRows, error: kvError } = await client
                .from('camp_state_kv')
                .select('key, value, updated_at')
                .eq('camp_id', campId);

            if (kvError) {
                if (kvError.code === '42501') {
                    log('RLS denied camp_state_kv read (expected for viewer role) — using local settings');
                    _cloudHydrationDone = true;
                    _dispatchHydrated();
                    return;
                }
                if (kvError.code !== 'PGRST116' && kvError.code !== '42P01') {
                    // 42P01 = relation does not exist (migration not yet run)
                    logError('camp_state_kv read failed:', kvError);
                }
                // Fall through to legacy table fallback
            }

            // Per-key cloud timestamps — used below for fine-grained merge.
            // Without this, a stale device with a recent overall updated_at
            // (because it edited any single key) would clobber unrelated
            // cloud keys whose individual timestamps are newer.
            let cloudPerKeyTime = null;
            if (Array.isArray(kvRows) && kvRows.length > 0) {
                // Content hash check — skip redundant hydration if cloud
                // data hasn't changed since our last read. This catches
                // Supabase realtime echoes that slip past the self-write
                // guard (e.g. round-trip >3s).
                const hash = _kvRowsHash(kvRows);
                if (_lastHydrationHash && hash === _lastHydrationHash && _cloudHydrationDone) {
                    log('Cloud data unchanged (hash match) — skipping redundant hydration');
                    return;
                }
                _lastHydrationHash = hash;

                cloudState = {};
                cloudPerKeyTime = {};
                let maxUpdated = 0;
                for (const row of kvRows) {
                    cloudState[row.key] = row.value;
                    // Treat a missing/null updated_at as Infinity (cloud
                    // always wins) rather than 0 (local always wins). A
                    // null timestamp means the row was inserted via a
                    // backfill / migration path that didn't stamp it —
                    // we'd rather trust cloud than risk a stale local
                    // edit clobbering it.
                    const t = row.updated_at ? new Date(row.updated_at).getTime() : Number.POSITIVE_INFINITY;
                    cloudPerKeyTime[row.key] = t;
                    if (Number.isFinite(t) && t > maxUpdated) maxUpdated = t;
                }
                if (maxUpdated > 0) {
                    cloudUpdatedAt = new Date(maxUpdated).toISOString();
                    cloudState.updated_at = cloudUpdatedAt;
                }
                log(`Hydrated ${kvRows.length} keys from camp_state_kv`);
            } else {
                // Legacy fallback — pre-migration DB or no KV rows yet
                const { data: legacyData, error: legacyError } = await client
                    .from('camp_state')
                    .select('state')
                    .eq('camp_id', campId)
                    .single();

                if (legacyError) {
                    if (legacyError.code === 'PGRST116') {
                        log('No cloud state found (neither table), using local');
                    } else if (legacyError.code === '42501') {
                        log('RLS denied camp_state read (expected for scheduler role) — using local settings');
                    } else {
                        logError('Hydration failed (legacy table):', legacyError);
                    }
                    _cloudHydrationDone = true;
                    _dispatchHydrated();
                    return;
                }

                if (legacyData?.state) {
                    cloudState = legacyData.state;
                    cloudUpdatedAt = cloudState.updated_at || null;
                    usedFallback = true;
                    log('Hydrated from legacy camp_state blob (KV table empty for this camp)');
                }
            }

            if (cloudState) {
                const localState = getLocalSettings();

                const cloudTime = new Date(cloudState.updated_at || 0).getTime();
                const localTime = new Date(localState.updated_at || 0).getTime();

                // If the last localStorage write failed (typically quota
                // exceeded after a CSV import or similar bulk update),
                // local is silently stale. Check sessionStorage AND
                // localStorage for the marker — sessionStorage has its
                // own quota separate from localStorage and survives the
                // failure that triggered the marker.
                let localWriteFailed = false;
                try { localWriteFailed = sessionStorage.getItem('_campistry_local_write_failed') === '1'; } catch (_) {}
                if (!localWriteFailed) {
                    try { localWriteFailed = localStorage.getItem('_campistry_local_write_failed') === '1'; } catch (_) {}
                }

                // Belt-and-suspenders: even if no marker survived (e.g. after
                // closing all tabs), detect when cloud has notably more data
                // than local. If cloud has campers/bunks/divisions that local
                // is missing, local is stale regardless of what its
                // updated_at says — quota failures don't update those
                // counts in local but cloud receives them per-key.
                let cloudHasMoreData = false;
                try {
                    const lr = (localState.app1 && localState.app1.camperRoster) || {};
                    const cr = (cloudState.app1 && cloudState.app1.camperRoster) || {};
                    if (Object.keys(cr).length > Object.keys(lr).length + 5) cloudHasMoreData = true;
                    const lb = (localState.bunks || []).length;
                    const cb = (cloudState.bunks || []).length;
                    if (cb > lb + 2) cloudHasMoreData = true;
                    const ld = Object.keys(localState.divisions || {}).length;
                    const cd = Object.keys(cloudState.divisions || {}).length;
                    if (cd > ld) cloudHasMoreData = true;
                } catch (_) {}

                let mergedState;
                let trustLocal = false;
                if (localWriteFailed) {
                    mergedState = cloudState;
                    log('Using cloud state (last local write failed — quota)');
                } else if (cloudHasMoreData) {
                    mergedState = cloudState;
                    log('Using cloud state (cloud has more data than local — likely silent local-write loss)');
                } else if (localTime > cloudTime) {
                    // Per-key merge when KV table is available. For each key
                    // present in cloud, only let local overwrite if local's
                    // overall updated_at is newer than that key's individual
                    // cloud timestamp. This protects keys that were updated
                    // on Device A while Device B's local has a newer overall
                    // stamp (from editing some unrelated key).
                    if (cloudPerKeyTime) {
                        mergedState = { ...cloudState };
                        for (const k of Object.keys(localState)) {
                            if (k === 'updated_at') continue;
                            const cloudKeyTime = cloudPerKeyTime[k] || 0;
                            if (!(k in cloudState) || localTime > cloudKeyTime) {
                                mergedState[k] = localState[k];
                            }
                        }
                        log('Using local state (newer, per-key merged)');
                    } else {
                        mergedState = { ...cloudState, ...localState };
                        log('Using local state (newer)');
                    }
                    trustLocal = true;
                } else {
                    mergedState = cloudState;
                    log('Using cloud state (newer)');
                }

                // When IDB preload succeeded, local has trustworthy data.
                // Fill any top-level keys present locally but missing from
                // cloud — these were saved to IDB but never synced (e.g.
                // campStructure during prior localStorage quota failures).
                //
                // Skip when cloudHasMoreData / localWriteFailed: those
                // paths just decided cloud is more trustworthy than local,
                // so backfilling local-only keys would partly undo that
                // decision and re-introduce stale state.
                if (_idbPreloadSucceeded && !trustLocal && !cloudHasMoreData && !localWriteFailed) {
                    let backfilled = 0;
                    for (const k of Object.keys(localState)) {
                        if (k === 'updated_at') continue;
                        if (!(k in mergedState) || mergedState[k] === null) {
                            mergedState[k] = localState[k];
                            backfilled++;
                        }
                    }
                    if (backfilled > 0) {
                        log(`Backfilled ${backfilled} local-only key(s) into cloud state (IDB had data cloud was missing)`);
                    }
                }

                // ★ Preserve local-only app1 keys (e.g. builderMode UI state)
                //   through hydration — but ONLY when we trust local. When we
                //   chose cloud because local was stale (quota failure or
                //   cloud-has-more-data), spreading local.app1 here would
                //   undo the cloud choice and silently restore the stale
                //   camperRoster / bunks / etc. that we deliberately
                //   discarded above.
                if (trustLocal && (localState.app1 || cloudState.app1)) {
                    mergedState.app1 = { ...(cloudState.app1 || {}), ...(localState.app1 || {}) };
                }

                // ★ Preserve special-activity SUBCATEGORY tags across the cross-device
                //   merge. app1 syncs as ONE blob (last-write-wins), so a device that
                //   never tagged specials can clobber a device that did — specialActivities
                //   has no field-level merge. Rule: for each special on the winning side
                //   that ended up BLANK, restore its subcategory from either side if a
                //   tagged copy exists (prefer-tagged, same as loadData). Only fills BLANK
                //   rows, so an intentional tag CHANGE (non-blank) on the newer device is
                //   still respected. (Edge case: an intentional un-tag on another device
                //   may be resurrected from a tagged local copy — acceptable vs. silent
                //   tag-wipe, which was the reported bug.)
                try {
                    if (mergedState.app1 && Array.isArray(mergedState.app1.specialActivities)) {
                        const _lSpecs = (localState.app1 && Array.isArray(localState.app1.specialActivities)) ? localState.app1.specialActivities : [];
                        const _cSpecs = (cloudState.app1 && Array.isArray(cloudState.app1.specialActivities)) ? cloudState.app1.specialActivities : [];
                        const _subByName = {};
                        [..._cSpecs, ..._lSpecs].forEach(function (s) {
                            if (!s || !s.name) return;
                            const sub = (typeof s.subcategory === 'string') ? s.subcategory.trim() : '';
                            if (sub && !_subByName[s.name]) _subByName[s.name] = s.subcategory;
                        });
                        let _restored = 0;
                        mergedState.app1.specialActivities.forEach(function (s) {
                            if (!s || !s.name) return;
                            const cur = (typeof s.subcategory === 'string') ? s.subcategory.trim() : '';
                            if (!cur && _subByName[s.name]) { s.subcategory = _subByName[s.name]; _restored++; }
                        });
                        if (_restored > 0) log('Preserved ' + _restored + ' special subcategory tag(s) across cross-device cloud merge');
                    }
                } catch (_eMergeSubcat) { logError('subcategory-preserve merge error:', _eMergeSubcat); }

                setLocalSettings(mergedState);

                // Suppress realtime echo — setLocalSettings wrote to localStorage/IDB
                // which may eventually trigger a cloud sync. Marking now prevents the
                // realtime subscription from re-hydrating for our own write.
                _lastSelfWriteAt = Date.now();

                // Do NOT assign window.divisions directly from the flat top-level key —
                // that bypasses the campStructure → grade-based transformation in app1.loadData().
                // The campistry-cloud-hydrated event triggers app1 to rebuild from campStructure.
                console.log('☁️ Hydrated from cloud:', {
                    divisions: Object.keys(mergedState.divisions || {}).length,
                    bunks: (mergedState.bunks || []).length
                });

                _cloudHydrationDone = true;
                _dispatchHydrated();
            }
        } catch (e) {
            logError('Hydration exception:', e);

            // Let the campistry-cloud-hydrated event trigger app1 to rebuild from campStructure
            _cloudHydrationDone = true;
            _dispatchHydrated();
            return;
        }

        // First-time camp setup: KV table empty AND legacy table empty.
        // Earlier we'd silently fall out of the function without dispatching
        // — `_cloudHydrationDone` stayed false forever, so executeBatchSync's
        // hold-until-hydrated check (line 589) would block every save in
        // the session. Always finalize.
        if (!_cloudHydrationDone) {
            log('Hydration complete with no cloud rows — dispatching anyway so sync system unblocks');
            _cloudHydrationDone = true;
            _dispatchHydrated();
        }
    }

    // =========================================================================
    // ★ LIVE — camp_state realtime subscription
    // Divisions/grades/bunks/campers come from Campistry Me. When any client
    // (this tab, another tab, another device) writes camp_state, we re-hydrate
    // and fire `campistry-cloud-hydrated`. app1/Me/Go all listen for that and
    // re-render. Self-writes are ignored via _lastSelfWriteAt to prevent echo.
    // =========================================================================

    let _campStateChannel = null;
    let _lastSelfWriteAt = 0;
    let _lastHydrationDispatchAt = 0;       // throttle: min interval between dispatches
    let _lastHydrationHash = null;          // content hash: skip if cloud unchanged
    const HYDRATION_THROTTLE_MS = 10000;    // 10s — cloud doesn't change faster than this in practice
    let _campStateDebounceTimer = null;
    let _campStateSubscribed = false;
    let _campStateReconnectTimer = null;
    let _campStateReconnectAttempts = 0;
    let _campStateStableTimer = null;

    async function subscribeToCampState() {
        if (_campStateSubscribed) return;
        const client = window.CampistryDB?.getClient?.();
        const campId = window.CampistryDB?.getCampId?.();
        if (!client || !campId) {
            log('camp_state realtime: no client/campId yet, deferring');
            return;
        }
        // Role guard: viewers can't read camp_state_kv via RLS.
        // Schedulers have SELECT access (migration 006) so they subscribe.
        if (!_canReadCampState()) {
            log('camp_state realtime: role cannot read camp_state, skipping subscription');
            return;
        }
        _campStateSubscribed = true;
        try {
            const channelName = `camp-state-kv-${campId}-${Date.now()}`;
            log('camp_state_kv realtime: subscribing on', channelName);
            _campStateChannel = client.channel(channelName)
                .on('postgres_changes', {
                    event: '*',
                    schema: 'public',
                    table: 'camp_state_kv',
                    filter: `camp_id=eq.${campId}`
                }, function (payload) {
                    // Self-echo guard: our own UPSERT just fired this event.
                    if (Date.now() - _lastSelfWriteAt < 3000) {
                        log('camp_state change ignored (self echo)');
                        return;
                    }
                    // Debounce — bulk edits in Me arrive as a rapid burst.
                    if (_campStateDebounceTimer) clearTimeout(_campStateDebounceTimer);
                    _campStateDebounceTimer = setTimeout(async function () {
                        _campStateDebounceTimer = null;
                        log('camp_state remote change — re-hydrating');
                        await hydrateFromCloud();
                    }, 200);
                })
                .subscribe(function (status) {
                    log('camp_state subscription status:', status);
                    if (status === 'SUBSCRIBED') {
                        _campStateReconnectAttempts = 0;
                        // Schedule a decay timer — even if connectivity flaps
                        // and SUBSCRIBED never fires again as a clean reset,
                        // 60s of stable subscription resets the backoff so
                        // the next flap doesn't start at the previous (high)
                        // attempt count.
                        if (_campStateStableTimer) clearTimeout(_campStateStableTimer);
                        _campStateStableTimer = setTimeout(function () {
                            _campStateReconnectAttempts = 0;
                            _campStateStableTimer = null;
                        }, 60000);
                    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                        // Schedule a reconnect with capped exponential backoff.
                        // Without this, a transient network blip kills the
                        // realtime feed for the rest of the session — and
                        // remote edits from another device become invisible.
                        _campStateSubscribed = false;

                        // ★★★ FIX: re-entry guard around removeChannel ★★★
                        // removeChannel() unsubscribes the channel, which fires
                        // another CLOSED status event → calls this branch again
                        // → calls removeChannel() again → infinite recursion
                        // (RangeError: Maximum call stack size exceeded).
                        // Capture+null the ref BEFORE removeChannel so the
                        // re-entry sees null and skips the second call.
                        var _ch = _campStateChannel;
                        _campStateChannel = null;
                        if (_ch) {
                            try { client.removeChannel(_ch); } catch (_) {}
                        }
                        if (_campStateReconnectTimer) return;
                        const attempt = ++_campStateReconnectAttempts;
                        const delay = Math.min(30000, 2000 * Math.pow(2, attempt - 1));
                        log(`camp_state realtime: reconnect in ${delay}ms (attempt ${attempt})`);
                        _campStateReconnectTimer = setTimeout(function () {
                            _campStateReconnectTimer = null;
                            subscribeToCampState();
                        }, delay);
                    }
                });
        } catch (e) {
            logError('camp_state subscribe failed:', e);
            _campStateSubscribed = false;
        }
    }

    // Subscribe once the first hydration completes — guarantees CampistryDB
    // is ready. Subsequent hydrations (realtime, manual) don't re-subscribe.
    window.addEventListener('campistry-cloud-hydrated', function () {
        if (!_campStateSubscribed) subscribeToCampState();
    });

    // =========================================================================
    // WAIT FOR ALL SYSTEMS
    // =========================================================================

    async function waitForSystems() {
        // Preload the FULL state from IndexedDB before anything else reads
        // settings. This catches data that wouldn't fit the localStorage
        // sync-init snapshot (heavy keys: daily_schedules, history blobs,
        // full camperRoster on big camps).
        await preloadFromIdb();

        if (window.CampistryDB?.ready) {
            await window.CampistryDB.ready;
        }

        await new Promise(r => setTimeout(r, 200));

        // Register the cloud-hydration listener BEFORE hydration fires.
        // hydrateFromCloud() dispatches `campistry-cloud-hydrated`
        // synchronously; if installHooks() runs after, hookCloudHydration's
        // listener registers too late and the schedule never auto-loads
        // from cloud on first boot.
        hookCloudHydration();

        // Pre-warm RotationCloud so the auto-builder's first call hits a
        // populated 30s TTL cache instead of waiting on a network round-trip
        // (and falling back to empty if that fetch errors).
        try { window.RotationCloud?.load?.(); } catch (_) {}

        await hydrateFromCloud();

        console.log('🔗 All systems ready, installing hooks...');
        installHooks();
    }

    // =========================================================================
    // HOOK: DATE PICKER (WITH AUTO-SAVE)
    // =========================================================================

    const MAX_DATE_PICKER_RETRIES = 5;

    function hookDatePicker() {
        if (_datePickerHooked) return;
        
        const datePicker = document.getElementById('schedule-date-input') ||
                          document.getElementById('datepicker') ||
                          document.getElementById('calendar-date-picker');
        
        if (!datePicker) {
            _datePickerRetries++;
            if (_datePickerRetries < MAX_DATE_PICKER_RETRIES) {
                setTimeout(hookDatePicker, 2000);
            } else if (_datePickerRetries === MAX_DATE_PICKER_RETRIES) {
                log('Date picker not found on this page');
            }
            return;
        }
        
        _datePickerHooked = true;
        log('Date picker found, hooking...');
        
        if (datePicker.value && !window.currentScheduleDate) {
            window.currentScheduleDate = datePicker.value;
            log('Initial date set:', datePicker.value);
        }

        datePicker.addEventListener('change', async (e) => {
            const newDateKey = e.target.value;
            if (!newDateKey) { window._pendingDateTransition = null; return; }

            // ★★★ TRANSITION SERIALIZATION (cross-date corruption root fix) ★★★
            // Two date-changes must NEVER run concurrently: they share
            // window.scheduleAssignments, so an overlapping save-old/load-new from a
            // second navigation (e.g. a fast user clicking date C while date B is still
            // loading) interleaves and writes one day's schedule under another day's key.
            // Serialize: if a transition is already running, wait for it to finish before
            // starting this one. Bounded so a stuck transition can't deadlock navigation.
            const _txnWaitStart = Date.now();
            while (window.__dateTxnInProgress && (Date.now() - _txnWaitStart) < 12000) {
                await new Promise(r => setTimeout(r, 50));
            }
            window.__dateTxnInProgress = true;

            // Safety net: even if anything below throws, the transition flag
            // must eventually clear so save hooks don't stay blocked forever.
            const _txnSafety = setTimeout(() => {
                if (window._pendingDateTransition && window._pendingDateTransition.to === newDateKey) {
                    console.warn('🔗 Date transition safety clear (10s elapsed)');
                    window._pendingDateTransition = null;
                }
            }, 10000);
            try {

            // ★★★ FIX (date round-trip drift): calendar.js no longer eagerly
            // updates window.currentScheduleDate. Prefer the transition flag's
            // `from` value (the truly-old date) over window.currentScheduleDate
            // in case any other code raced ahead.
            const oldDateKey = window._pendingDateTransition?.from || window.currentScheduleDate;
            console.log('🔗 Date changed:', oldDateKey, '→', newDateKey);

            // ═══════════════════════════════════════════════════════════════
            // ★★★ AUTO-SAVE BEFORE DATE CHANGE ★★★
            // At this point window.scheduleAssignments still holds the OLD
            // date's data (load hasn't fired yet), so saving with oldDateKey
            // is correct.
            // ═══════════════════════════════════════════════════════════════
            if (oldDateKey && oldDateKey !== newDateKey) {
                const currentBunks = Object.keys(window.scheduleAssignments || {}).length;
                // ★★★ CROSS-DATE CORRUPTION GUARD ★★★
                // Only auto-save oldDateKey if the in-memory schedule STILL belongs to it.
                // If a racing date-change handler already swapped in another date's data,
                // saving here would write the wrong day's schedule under oldDateKey —
                // silently corrupting it (the exact bug this guards against). Inert when
                // the stamp is unset (degrades to prior behavior).
                const _memDate = window._scheduleAssignmentsDate;
                if (_memDate && _memDate !== oldDateKey) {
                    console.warn('🔗 SKIP auto-save before date change: in-memory data belongs to ' +
                                 _memDate + ', not ' + oldDateKey + ' — avoiding cross-date corruption');
                } else if (currentBunks > 0) {
                    console.log('🔗 Auto-saving before date change:', currentBunks, 'bunks');
                    showNotification('Saving...', 'info');
                    try {
                        await verifiedScheduleSave(oldDateKey);
                    } catch (e) {
                        logError('Auto-save failed:', e);
                    }
                }
            }

            window.currentScheduleDate = newDateKey;

            // Subscribe to realtime for this date
            if (window.ScheduleSync?.subscribe) {
                await window.ScheduleSync.subscribe(newDateKey);
            }

            // Load schedule for this date
            if (window.ScheduleDB?.loadSchedule) {
                const result = await window.ScheduleDB.loadSchedule(newDateKey);
                
                if (result?.success && result.data) {
                    window.scheduleAssignments = result.data.scheduleAssignments || {};
                    window.leagueAssignments = result.data.leagueAssignments || {};
                    // ★★★ CROSS-DATE GUARD: in-memory schedule now belongs to newDateKey.
                    // Keeps the date stamp coherent so the save guard never false-blocks a
                    // later edit/save on this date, and a racing save-old can detect drift.
                    window._scheduleAssignmentsDate = newDateKey;

                    // ★★★ FIX: Properly hydrate unifiedTimes ★★★
                    if (result.data.unifiedTimes?.length > 0) {
                        window.unifiedTimes = result.data.unifiedTimes;
                    }
                    if (result.data.divisionTimes) {
                        window.divisionTimes = result.data.divisionTimes;
                    }

                    // ★★★ FIX v6.5: Hydrate rainy day state ★★★
                    if (result.data.isRainyDay === true || result.data.rainyDayMode === true) {
                        window.isRainyDay = true;
                    } else if (result.data.isRainyDay === false) {
                        window.isRainyDay = false;
                    }
                    
                    if (result.data.rainyDayStartTime !== null && result.data.rainyDayStartTime !== undefined) {
                        window.rainyDayStartTime = result.data.rainyDayStartTime;
                    } else {
                        window.rainyDayStartTime = null;
                    }

                    if (window.updateTable) {
                        window.updateTable();
                    }

                    console.log('🔗 Loaded schedule for', newDateKey, {
                        bunks: Object.keys(window.scheduleAssignments).length,
                        slots: window.unifiedTimes?.length || 0,
                        isRainyDay: window.isRainyDay,
                        rainyDayStartTime: window.rainyDayStartTime,
                        source: result.source
                    });
                }
            }

            // ★★★ FIX (date round-trip drift): Memory and dateKey are now
            // coherent — clear the transition flag so save hooks resume.
            window._pendingDateTransition = null;
            } finally {
                clearTimeout(_txnSafety);
                if (window._pendingDateTransition && window._pendingDateTransition.to === newDateKey) {
                    window._pendingDateTransition = null;
                }
                // ★★★ Release the transition lock so a queued navigation can proceed.
                window.__dateTxnInProgress = false;
            }
        });

        console.log('🔗 Date picker hook installed');
    }

    // =========================================================================
    // HOOK: AUTO-SAVE ON SCHEDULE CHANGES
    // =========================================================================

    function hookScheduleSave() {
        if (window.saveCurrentDailyData) {
            const originalSave = window.saveCurrentDailyData;

            window.saveCurrentDailyData = function(key, value) {
                originalSave.call(this, key, value);

                const dateKey = window.currentScheduleDate;
                if (!dateKey) return;

                // ★★★ FIX (date round-trip drift): During a date transition,
                // window.currentScheduleDate may have already advanced (or, with
                // the calendar.js fix, may still be the old date) while memory
                // is mid-swap. Any save fired in this window writes mismatched
                // (dateKey, scheduleAssignments) to cloud. Bail out — the
                // post-load save hook will fire correctly once memory and
                // dateKey are coherent.
                if (window._pendingDateTransition) {
                    return;
                }

                // ★★★ CROSS-DATE GUARD: if the in-memory schedule's owner stamp
                // disagrees with the date we'd queue under, memory belongs to
                // another day (a concurrent hydrate/realtime swapped it). Queueing
                // it under dateKey would corrupt that day. Skip — the coherent
                // owner date will autosave correctly on its own.
                const _ownerStamp = window._scheduleAssignmentsDate;
                if (_ownerStamp && dateKey && _ownerStamp !== dateKey) {
                    console.warn('🔗 SKIP autosave queue: in-memory belongs to ' + _ownerStamp + ', not ' + dateKey);
                    return;
                }

                // ★★★ DAY 16 FIX: Don't queue a wipe-shaped save during init.
                // Every call to saveCurrentDailyData(key, value) — including
                // ones for UNRELATED settings — triggers this wrapper, which
                // queues a full scheduleAssignments save based on whatever's
                // currently in window.scheduleAssignments. During page init,
                // before cloud hydration completes, scheduleAssignments is
                // empty {}, so the queued payload is empty too. The debounce
                // delay then fires the empty save AFTER hydration brings in
                // the real data — overwriting cloud with empty.
                //
                // Skip the queue when the payload would wipe: no bunks at
                // all, or bunks present but ZERO scheduled activities (the
                // "structural skeleton" wipe-shape we observed in cloud).
                // unifiedTimes is NOT a safe signal because some configs
                // (period-based scheduling) keep it empty even on healthy
                // schedules. Legitimate post-edit/post-gen flows save via
                // verifiedScheduleSave / doCloudSaveWithVerification anyway.
                const sa = window.scheduleAssignments || {};
                const bunkCount = Object.keys(sa).length;
                if (bunkCount === 0) return;
                let hasAnyActivity = false;
                outer: for (const bk of Object.keys(sa)) {
                    const arr = sa[bk];
                    if (!Array.isArray(arr)) continue;
                    for (const slot of arr) {
                        if (slot && typeof slot === 'object') {
                            const act = slot._activity || slot.activity || slot.field || slot.sport;
                            if (act && act !== 'Free' && act !== '+ Add') {
                                hasAnyActivity = true;
                                break outer;
                            }
                        }
                    }
                }
                if (!hasAnyActivity) return;

                // ★★★ FIX v6.5: Include rainyDayStartTime and rainyDayMode ★★★
                const data = {
                    scheduleAssignments: sa,
                    leagueAssignments: window.leagueAssignments || {},
                    unifiedTimes: window.unifiedTimes || [],
                    divisionTimes: window.divisionTimes || {},
                    isRainyDay: window.isRainyDay || false,
                    rainyDayStartTime: window.rainyDayStartTime ?? null,
                    rainyDayMode: window.isRainyDay || false  // backward compatibility
                };

                if (window.ScheduleSync?.queueSave) {
                    window.ScheduleSync.queueSave(dateKey, data);
                }
            };

            console.log('🔗 Save hook installed');
        }
    }

    // =========================================================================
    // HOOK: GENERATION COMPLETE
    // =========================================================================

    function hookGeneration() {
        // Single handler for generation complete
        window.addEventListener('campistry-generation-complete', async (e) => {
            const dateKey = e.detail?.dateKey || window.currentScheduleDate;
            if (!dateKey) return;

            // ★★★ CROSS-DATE STAMP: generation just produced the in-memory schedule
            // for dateKey — bind the owner stamp so the verified save below (and any
            // concurrent autosave) is recognized as coherent, not refused as cross-date.
            window._scheduleAssignmentsDate = dateKey;

            const bunkCount = Object.keys(window.scheduleAssignments || {}).length;
            console.log('🔗 Generation complete for', dateKey, '-', bunkCount, 'bunks');

            // ★★★ v6.9 FIX: Save to localStorage IMMEDIATELY — no delay! ★★★
            // The old 1000ms "wait for data to settle" caused data loss on quick reload.
            // Data is already in window.scheduleAssignments when this event fires.
            try {
                const DAILY_KEY = 'campDailyData_v1';
                const allData = JSON.parse(localStorage.getItem(DAILY_KEY) || '{}');
                // ★★★ FIX: MERGE instead of replace — preserve auto-mode keys (_perBunkSlotsData, _autoGenerated, manualSkeleton) saved by Step 5 ★★★
                const existing = allData[dateKey] || {};
                Object.assign(existing, {
                    scheduleAssignments: window.scheduleAssignments || {},
                    leagueAssignments: window.leagueAssignments || {},
                    unifiedTimes: window.unifiedTimes || [],
                    divisionTimes: window.DivisionTimesSystem?.serialize?.(window.divisionTimes) || window.divisionTimes || {},
                    isRainyDay: window.isRainyDay || false,
                    rainyDayStartTime: window.rainyDayStartTime ?? null,
                    _savedAt: Date.now()
                });
                allData[dateKey] = existing;
                localStorage.setItem(DAILY_KEY, JSON.stringify(allData));
                console.log('🔗 ✅ Immediate localStorage save:', bunkCount, 'bunks');
            } catch (lsErr) {
                console.error('🔗 localStorage save failed:', lsErr);
            }

            // Then do verified cloud save (no artificial delay)
            await verifiedScheduleSave(dateKey);

            // ★★★ Update rotation history for ALL bunks ★★★
            // Manual edits call peiUpdateRotationHistory per bunk, but auto-gen never did.
            // This stamps every scheduled activity with the current timestamp so next-day
            // variety scoring knows what was done today.
            try {
                const newSched = window.scheduleAssignments || {};
                const history = window.loadRotationHistory?.() || { bunks: {}, leagues: {} };
                history.bunks = history.bunks || {};
                const timestamp = Date.now();
                const SKIP = new Set(['free', 'free play', 'free (timeout)', 'transition/buffer', 'regroup', 'lineup', 'bus', 'buffer']);
                Object.keys(newSched).forEach(bunk => {
                    history.bunks[bunk] = history.bunks[bunk] || {};
                    (newSched[bunk] || []).forEach(entry => {
                        if (!entry || entry.continuation || entry._isTransition) return;
                        const actName = entry._activity || '';
                        if (!actName || SKIP.has(actName.toLowerCase())) return;
                        history.bunks[bunk][actName] = timestamp;
                    });
                });
                window.saveRotationHistory?.(history);
                console.log('🔗 ✅ Rotation history updated for', Object.keys(newSched).length, 'bunks');
            } catch (rhErr) {
                console.error('🔗 Rotation history update failed:', rhErr);
            }

            // ★★★ Rebuild historicalCounts from the freshly-saved allDaily ★★★
            // The previous reIncrement-with-snapshot approach was unreliable here:
            // by the time this listener fires, the underlying generators
            // (scheduler_core_main / scheduler_core_auto) have already written the
            // new schedule to localStorage, so any "pre-save" snapshot we try to
            // capture is actually the new data — leading to silent drift on regen.
            // Rebuild scans allDaily once and is fully deterministic.
            if (window.SchedulerCoreUtils?.rebuildHistoricalCounts) {
                try { window.SchedulerCoreUtils.rebuildHistoricalCounts(true); }
                catch (e) { console.warn('🔗 historicalCounts rebuild failed:', e); }
            }
            if (window.RotationCloud?.save) {
                try { window.RotationCloud.save(dateKey, window.scheduleAssignments || {}); }
                catch (e) { console.warn('🔗 RotationCloud sync failed:', e); }
            }
        }, { once: false });
        // Intercept generateSchedule if it exists
        if (window.generateSchedule) {
            const originalGenerate = window.generateSchedule;

            window.generateSchedule = async function(dateKey, ...args) {
                // ★★★ v6.7 SECURITY: Verify write permission even on direct console call ★★★
                if (window.AccessControl?.verifyBeforeWrite) {
                    const allowed = await window.AccessControl.verifyBeforeWrite('generate schedule');
                    if (!allowed) {
                        console.warn('🔗 [Hooks] Generation BLOCKED — write permission denied');
                        return null;
                    }
                }

                const result = await originalGenerate.call(this, dateKey, ...args);

                window.dispatchEvent(new CustomEvent('campistry-generation-complete', {
                    detail: { dateKey }
                }));

                return result;
            };

            console.log('🔗 Generation hook installed');
        }
    }

    // =========================================================================
    // HOOK: HANDLE REMOTE CHANGES (v6.1 - WITH BYPASS GUARD)
    // =========================================================================

    function hookRemoteChanges() {
        if (!window.ScheduleSync?.onRemoteChange) {
            console.log('🔗 ScheduleSync not ready for remote hooks');
            return;
        }

       window.ScheduleSync.onRemoteChange((change) => {
            // Skip during post-edit/bypass operations
            if (window._postEditInProgress) {
                console.log('🔗 Skipping remote merge - post-edit in progress');
                return;
            }
            
            // ★★★ v6.9 FIX: Skip during active generation ★★★
            if (window._generationInProgress) {
                console.log('🔗 Skipping remote merge - generation in progress');
                return;
            }
            
            console.log('🔗 Remote change received:', change.type, 'from', change.scheduler);

            if (window.ScheduleDB?.loadSchedule && change.dateKey) {
                window.ScheduleDB.loadSchedule(change.dateKey).then(result => {
                    if (window._postEditInProgress || window._generationInProgress) {
                        console.log('🔗 Skipping merge - operation in progress');
                        return;
                    }

                    // ★★★ CROSS-DATE GUARD (cloud corruption root fix) ★★★
                    // window.scheduleAssignments only ever holds the CURRENTLY-VIEWED
                    // date. A realtime change for any OTHER date must NOT be merged
                    // into memory — doing so clobbers the viewed day's schedule and
                    // desyncs the owner stamp, so the next autosave/save-old writes the
                    // wrong day's data under the current date's cloud key (silent
                    // cross-date corruption). For non-viewed dates we only refresh that
                    // date's localStorage cache (cloud stays authoritative on navigate).
                    if (change.dateKey && window.currentScheduleDate && change.dateKey !== window.currentScheduleDate) {
                        try {
                            const DAILY_KEY = 'campDailyData_v1';
                            const allData = JSON.parse(localStorage.getItem(DAILY_KEY) || '{}');
                            if (result?.success && result.recordCount === 0) {
                                delete allData[change.dateKey];
                            } else if (result?.success && result.data) {
                                allData[change.dateKey] = {
                                    scheduleAssignments: result.data.scheduleAssignments || {},
                                    leagueAssignments: result.data.leagueAssignments || {},
                                    unifiedTimes: result.data.unifiedTimes || [],
                                    divisionTimes: result.data.divisionTimes || {}
                                };
                            }
                            localStorage.setItem(DAILY_KEY, JSON.stringify(allData));
                        } catch (e) { /* ignore localStorage errors */ }
                        console.log('🔗 Remote change for non-current date ' + change.dateKey +
                                    ' — cached to localStorage; in-memory (' + window.currentScheduleDate + ') untouched');
                        return;
                    }

                    if (result?.success && result.recordCount === 0) {
                        // ★ Cloud empty = owner deleted everything → full clear
                        console.log('🔗 Cloud is empty — clearing all local data');
                        window.scheduleAssignments = {};
                        window.leagueAssignments = {};
                        window.divisionTimes = {};
                        window.unifiedTimes = [];
                        window._localGenerationTimestamp = 0;
                        window._scheduleAssignmentsDate = change.dateKey; // owner stamp coherent with cleared memory
                        try {
                            var DAILY_KEY = 'campDailyData_v1';
                            var allData = JSON.parse(localStorage.getItem(DAILY_KEY) || '{}');
                            delete allData[change.dateKey];
                            localStorage.setItem(DAILY_KEY, JSON.stringify(allData));
                        } catch (e) { /* ignore */ }
                        if (window.updateTable) window.updateTable();
                        console.log('🔗 ✅ Cleared — cloud had 0 records');
                        return;
                    }

                    if (result?.success && result.data) {
                        // ★★★ v6.9 CRITICAL FIX: Properly merge — keep MY data, add THEIR data ★★★
                        const myBunks = new Set(
                            window.AccessControl?.getEditableBunks?.() ||
                            window.CloudPermissions?.getEditableBunks?.() || []
                        );
                        
                        const cloudAssignments = result.data.scheduleAssignments || {};
                        const currentAssignments = window.scheduleAssignments || {};
                        
                        // Start with cloud data (has ALL schedulers merged)
                        const merged = { ...cloudAssignments };
                        
                        // Overlay MY current bunks (preserve my in-progress work)
                        for (const [bunk, slots] of Object.entries(currentAssignments)) {
                            if (myBunks.has(bunk) || myBunks.has(String(bunk))) {
                                merged[bunk] = slots;
                            }
                        }
                        
                        window.scheduleAssignments = merged;
                        window._scheduleAssignmentsDate = change.dateKey; // owner stamp coherent with merged remote data

                        // Also merge league assignments (keyed by DIVISION NAME, not bunk)
                        if (result.data.leagueAssignments) {
                            const cloudLeagues = result.data.leagueAssignments || {};
                            const currentLeagues = window.leagueAssignments || {};
                            const myDivisions = new Set(
                                window.AccessControl?.getEditableDivisions?.() || []
                            );
                            const mergedLeagues = { ...cloudLeagues };
                            // Overlay MY divisions' league data
                            for (const [divName, divData] of Object.entries(currentLeagues)) {
                                if (myDivisions.has(divName)) {
                                    mergedLeagues[divName] = divData;
                                }
                            }
                            window.leagueAssignments = mergedLeagues;
                        }
                        
                        // Hydrate times
                        if (result.data.unifiedTimes?.length > 0) {
                            window.unifiedTimes = result.data.unifiedTimes;
                        }
                        if (result.data.divisionTimes) {
                            window.divisionTimes = result.data.divisionTimes;
                        }
                        
                        // Update localStorage with merged data
                        const dateKey = change.dateKey;
                        try {
                            const DAILY_KEY = 'campDailyData_v1';
                            const allData = JSON.parse(localStorage.getItem(DAILY_KEY) || '{}');
                            allData[dateKey] = {
                                scheduleAssignments: merged,
                                leagueAssignments: window.leagueAssignments || {},
                                unifiedTimes: window.unifiedTimes || [],
                                divisionTimes: window.divisionTimes || {}
                            };
                            localStorage.setItem(DAILY_KEY, JSON.stringify(allData));
                        } catch (e) { /* ignore localStorage errors */ }
                        
                        const totalBunks = Object.keys(merged).length;
                        console.log(`🔗 ✅ Merged remote update: ${totalBunks} total bunks (${myBunks.size} mine preserved)`);

                        // ★★★ FIX: Also update unifiedTimes from remote ★★★
                        if (result.data.unifiedTimes?.length > (window.unifiedTimes?.length || 0)) {
                            window.unifiedTimes = result.data.unifiedTimes;
                        }

                        // ★★★ FIX v6.5: Also update rainy day state from remote ★★★
                        if (result.data.isRainyDay === true || result.data.rainyDayMode === true) {
                            window.isRainyDay = true;
                        } else if (result.data.isRainyDay === false) {
                            window.isRainyDay = false;
                        }
                        
                        if (result.data.rainyDayStartTime !== null && result.data.rainyDayStartTime !== undefined) {
                            window.rainyDayStartTime = result.data.rainyDayStartTime;
                        }

                        if (window.updateTable) {
                            window.updateTable();
                        }

                        console.log('🔗 Merged remote changes');
                    }
                });
            }
        });

        console.log('🔗 Remote change hook installed');
    }

    // =========================================================================
    // HOOK: BLOCKED CELL RENDERING
    // =========================================================================

    function hookBlockedCells() {
        if (window.updateTable) {
            const originalUpdate = window.updateTable;

            window.updateTable = function(...args) {
                originalUpdate.apply(this, args);
                applyBlockedCellStyles();
            };

            console.log('🔗 Blocked cell hook installed');
        }
    }

    function applyBlockedCellStyles() {
        // Use CloudPermissions for consistent permission checking
        if (window.CloudPermissions?.hasFullAccess?.()) {
            return;
        }

        const editableBunks = new Set(window.CloudPermissions?.getEditableBunks?.() || []);
        
        document.querySelectorAll('.schedule-cell').forEach(cell => {
            const bunkId = cell.dataset?.bunkId;
            if (bunkId && !editableBunks.has(String(bunkId))) {
                cell.classList.add('blocked-cell');
                cell.title = 'View only - assigned to another scheduler';
            }
        });
    }

    function addBlockedCellStyles() {
        if (document.getElementById('blocked-cell-styles')) return;
        
        const style = document.createElement('style');
        style.id = 'blocked-cell-styles';
        style.textContent = `
            .blocked-cell {
                opacity: 0.6;
                pointer-events: none;
                background: repeating-linear-gradient(
                    45deg,
                    transparent,
                    transparent 5px,
                    rgba(0,0,0,0.03) 5px,
                    rgba(0,0,0,0.03) 10px
                ) !important;
            }
            .blocked-cell::after {
                content: '🔒';
                position: absolute;
                top: 2px;
                right: 2px;
                font-size: 10px;
                opacity: 0.5;
            }
        `;
        document.head.appendChild(style);
    }

    // =========================================================================
    // HOOK: ERASE FUNCTIONS
    // =========================================================================

    function hookEraseFunctions() {
        if (typeof window.eraseAllSchedules === 'function') {
            const original = window.eraseAllSchedules;
            
           window.eraseAllSchedules = async function(dateKey) {
                // ★★★ v6.7 SECURITY: Verify write permission before erase ★★★
                if (window.AccessControl?.verifyBeforeWrite) {
                    const allowed = await window.AccessControl.verifyBeforeWrite('erase schedules');
                    if (!allowed) {
                        console.warn('🔗 [Hooks] Erase BLOCKED — write permission denied');
                        return;
                    }
                }

                // Use CloudPermissions for consistent permission checking
                const hasFullAccess = window.CloudPermissions?.hasFullAccess?.() || false;
                
                if (hasFullAccess) {
                    if (!confirm(`Delete ALL schedules for ${dateKey}?\n\nThis will delete data from all schedulers.`)) {
                        return;
                    }
                    await window.ScheduleDB?.deleteSchedule?.(dateKey);
                } else {
                    if (!confirm(`Delete YOUR schedule for ${dateKey}?\n\nOther schedulers' data will be preserved.`)) {
                        return;
                    }
                    await window.ScheduleDB?.deleteMyScheduleOnly?.(dateKey);
                }

                window.scheduleAssignments = {};
                window.leagueAssignments = {};

                const result = await window.ScheduleDB?.loadSchedule?.(dateKey);
                if (result?.success && result.data) {
                    window.scheduleAssignments = result.data.scheduleAssignments || {};
                    window.leagueAssignments = result.data.leagueAssignments || {};
                }
                // ★★★ CROSS-DATE GUARD: stamp the date this reloaded data belongs to.
                window._scheduleAssignmentsDate = dateKey;

                if (window.updateTable) {
                    window.updateTable();
                }

                console.log('🔗 Erase complete for', dateKey);
            };

            console.log('🔗 Erase hook installed');
        }
    }

    // =========================================================================
    // HOOK: BEFOREUNLOAD - SAVE ON PAGE EXIT
    // =========================================================================

    function hookBeforeUnload() {
        window.addEventListener('beforeunload', (e) => {
            const dateKey = window.currentScheduleDate;
            const bunkCount = Object.keys(window.scheduleAssignments || {}).length;

            // Build the same full payload verifiedScheduleSave uses so the
            // beforeunload save doesn't drop _perBunkSlotsData / manualSkeleton
            // / _autoGenerated and silently regress the auto-mode geometry.
            // (The minimal payload that used to live here was the exact bug
            // verifiedScheduleSave was added to prevent.)
            const buildFullPayload = () => {
                const _spbs = {};
                const _dt = window.divisionTimes || {};
                Object.keys(_dt).forEach(g => {
                    if (_dt[g]?._perBunkSlots) _spbs[g] = _dt[g]._perBunkSlots;
                });
                const payload = {
                    scheduleAssignments: window.scheduleAssignments || {},
                    leagueAssignments: window.leagueAssignments || {},
                    unifiedTimes: window.unifiedTimes || [],
                    divisionTimes: window.DivisionTimesSystem?.serialize?.(window.divisionTimes) || _dt,
                    isRainyDay: window.isRainyDay || false,
                    rainyDayStartTime: window.rainyDayStartTime ?? null,
                    rainyDayMode: window.isRainyDay || false,
                    savedAt: new Date().toISOString()
                };
                if (Object.keys(_spbs).length > 0) payload._perBunkSlotsData = _spbs;
                if (window._autoSkeleton) payload.manualSkeleton = window._autoSkeleton;
                if (window.dailyOverrideSkeleton && Array.isArray(window.dailyOverrideSkeleton) && window.dailyOverrideSkeleton.length > 0) {
                    payload.manualSkeleton = payload.manualSkeleton || window.dailyOverrideSkeleton;
                }
                try {
                    const _lsRow = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}')[dateKey];
                    if (_lsRow?._autoGenerated) payload._autoGenerated = true;
                } catch (_) {}
                return payload;
            };

            if (dateKey && bunkCount > 0) {
                console.log('🔗 Page unloading, final save...');

                const payload = buildFullPayload();

                // Synchronous localStorage save (guaranteed)
                try {
                    const DAILY_KEY = 'campDailyData_v1';
                    const allData = JSON.parse(localStorage.getItem(DAILY_KEY) || '{}');
                    allData[dateKey] = payload;
                    localStorage.setItem(DAILY_KEY, JSON.stringify(allData));
                } catch (err) {
                    logError('Final save failed:', err);
                }

                // Attempt cloud save (may not complete)
                window.ScheduleDB?.saveSchedule?.(dateKey, payload).catch(() => {});
            }

            // Flush _pendingChanges (camp_state_kv batch) via fetch with
            // keepalive: true so the request survives tab close. The
            // supabase-js upsert path doesn't set keepalive, so it dies
            // with the tab on slow networks. We send the request manually
            // to the Supabase REST endpoint with the cached access token.
            try {
                const pending = (typeof _pendingChanges === 'object' && _pendingChanges) ? _pendingChanges : {};
                const pendingKeys = Object.keys(pending).filter(k => k !== 'updated_at');
                const cfg = window.CampistryDB?.config;
                const campId = window.CampistryDB?.getCampId?.();
                // Skip if we have no fresh cached token — sending without
                // one would 401, then the optimistic clear below would
                // drop the pending edits with no chance to retry.
                if (pendingKeys.length > 0 && _cachedAccessToken && cfg?.SUPABASE_URL && cfg?.SUPABASE_ANON_KEY && campId) {
                    const nowIso = new Date().toISOString();
                    const rows = pendingKeys.map(k => ({
                        camp_id: campId,
                        key: k,
                        value: pending[k] ?? null,
                        updated_at: nowIso
                    }));
                    // Body cap: fetch keepalive limits total in-flight body
                    // size to ~64KB. Anything bigger we let the regular
                    // executeBatchSync attempt fire-and-forget.
                    const body = JSON.stringify(rows);
                    if (body.length < 60000) {
                        fetch(`${cfg.SUPABASE_URL}/rest/v1/camp_state_kv?on_conflict=camp_id,key`, {
                            method: 'POST',
                            keepalive: true,
                            headers: {
                                'apikey': cfg.SUPABASE_ANON_KEY,
                                'Authorization': `Bearer ${_cachedAccessToken}`,
                                'Content-Type': 'application/json',
                                'Prefer': 'resolution=merge-duplicates,return=minimal'
                            },
                            body
                        }).catch(() => {});
                        // Optimistically clear so a regular executeBatchSync
                        // call right after doesn't race-double-submit.
                        pendingKeys.forEach(k => delete _pendingChanges[k]);
                    }
                }
                // Belt-and-suspenders fallback for over-cap payloads or
                // when no cached token is available.
                if (typeof executeBatchSync === 'function') executeBatchSync();
            } catch (_) {}
        });

        console.log('🔗 beforeunload hook installed');
    }

    // =========================================================================
    // HOOK: AUTO-LOAD FROM CLOUD AFTER HYDRATION
    // =========================================================================

    let _hookCloudHydrationRegistered = false;
    function hookCloudHydration() {
        // Idempotent: waitForSystems registers this BEFORE hydrateFromCloud
        // (so the listener catches the first hydration event), and
        // installHooks also calls it — guard so the listener is bound once.
        if (_hookCloudHydrationRegistered) return;
        _hookCloudHydrationRegistered = true;

        window.addEventListener('campistry-cloud-hydrated', async () => {
            if (_scheduleCloudLoadDone) return;
            _scheduleCloudLoadDone = true;

            log('[HOOK] Cloud hydrated, checking for schedule data...');

            await new Promise(r => setTimeout(r, 500));

            const dateKey = window.currentScheduleDate ||
                           document.getElementById('schedule-date-input')?.value ||
                           document.getElementById('datepicker')?.value ||
                           document.getElementById('calendar-date-picker')?.value;

            if (!dateKey) {
                log('[HOOK] No date key available');
                return;
            }

            // Don't clobber an in-flight generation or post-edit. The
            // realtime hookRemoteChanges path already gates on these — this
            // path needs the same guard so a realtime re-hydration mid-edit
            // doesn't wipe unsaved in-memory work.
            if (window._postEditInProgress || window._generationInProgress) {
                log('[HOOK] Skipping cloud reload — generation/edit in progress');
                return;
            }

            const currentBunks = Object.keys(window.scheduleAssignments || {}).length;

            if (currentBunks === 0) {
                log('[HOOK] No local data, fetching from cloud...');
                await forceLoadScheduleFromCloud(dateKey);
            } else {
                log('[HOOK] Local data exists, refreshing from cloud...');
                await forceLoadScheduleFromCloud(dateKey);
            }
        });
    }

    // =========================================================================
    // INSTALL ALL HOOKS
    // =========================================================================

    function installHooks() {
        addBlockedCellStyles();
        hookDatePicker();
        hookScheduleSave();
        hookGeneration();
        hookRemoteChanges();
        hookBlockedCells();
        hookEraseFunctions();
        hookBeforeUnload();
        hookCloudHydration();

        // Expose helper functions globally
        window.scheduleCloudSync = function() {
            const dateKey = window.currentScheduleDate;
            if (!dateKey) return;

            // ★★★ FIX v6.5: Include rainyDayStartTime and rainyDayMode ★★★
            const data = {
                scheduleAssignments: window.scheduleAssignments || {},
                leagueAssignments: window.leagueAssignments || {},
                unifiedTimes: window.unifiedTimes || [],
                divisionTimes: window.divisionTimes || {},
                isRainyDay: window.isRainyDay || false,
                rainyDayStartTime: window.rainyDayStartTime ?? null,
                rainyDayMode: window.isRainyDay || false
            };

            if (window.ScheduleSync?.queueSave) {
                window.ScheduleSync.queueSave(dateKey, data);
            }
        };

        window.forceCloudSync = async function() {
            await window.ScheduleSync?.forceSync?.();
            await forceSyncToCloud();
        };

        // Expose verified save functions
        window.verifiedScheduleSave = verifiedScheduleSave;
        window.forceLoadScheduleFromCloud = forceLoadScheduleFromCloud;

        console.log('🔗 All hooks installed!');

        window.dispatchEvent(new CustomEvent('campistry-integration-ready'));

        const currentDate = window.currentScheduleDate || document.getElementById('schedule-date-input')?.value || document.getElementById('calendar-date-picker')?.value;
        if (currentDate && window.ScheduleSync?.subscribe) {
            console.log('🔗 Auto-subscribing to current date:', currentDate);
            window.ScheduleSync.subscribe(currentDate);
        }
    }

    // =========================================================================
    // DIAGNOSTIC FUNCTION
    // =========================================================================

    window.diagnoseScheduleSync = async function() {
        const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        const campId = window.CampistryDB?.getCampId?.();
        const userId = window.CampistryDB?.getUserId?.();
        const client = window.CampistryDB?.getClient?.();

        console.log('═══════════════════════════════════════════════════════');
        console.log('SCHEDULE SYNC DIAGNOSTIC v6.8');
        console.log('═══════════════════════════════════════════════════════');
        console.log('Date:', dateKey);
        console.log('Online:', navigator.onLine);
        console.log('Camp ID:', campId || 'MISSING');
        console.log('User ID:', userId?.substring(0, 8) + '...' || 'MISSING');
        console.log('Can write camp_state:', _canWriteCampState());
        console.log('');
        console.log('Window globals:');
        console.log('  scheduleAssignments:', Object.keys(window.scheduleAssignments || {}).length, 'bunks');
        console.log('  unifiedTimes:', (window.unifiedTimes || []).length, 'slots');
        console.log('  divisionTimes:', Object.keys(window.divisionTimes || {}).length, 'divisions');
        console.log('  isRainyDay:', window.isRainyDay);
        console.log('  rainyDayStartTime:', window.rainyDayStartTime);
        console.log('');
        console.log('CloudPermissions:');
        console.log('  Role:', window.CloudPermissions?.getRole?.());
        console.log('  Has Full Access:', window.CloudPermissions?.hasFullAccess?.());
        console.log('  Editable Divisions:', window.CloudPermissions?.getEditableDivisions?.()?.length || 0);
        console.log('  Editable Bunks:', window.CloudPermissions?.getEditableBunks?.()?.length || 0);
        console.log('');

        if (client && campId) {
            try {
                const { data, error } = await client
                    .from('daily_schedules')
                    .select('scheduler_id, scheduler_name, divisions, updated_at, schedule_data, unified_times, is_rainy_day')
                    .eq('camp_id', campId)
                    .eq('date_key', dateKey);

                console.log('Cloud records:', data?.length || 0);
                if (data && data.length > 0) {
                    let totalCloudBunks = 0;
                    data.forEach((r, i) => {
                        const bunks = Object.keys(r.schedule_data?.scheduleAssignments || {}).length;
                        const slots = r.schedule_data?.unifiedTimes?.length || r.unified_times?.length || 0;
                        const isRainy = r.is_rainy_day || r.schedule_data?.isRainyDay || r.schedule_data?.rainyDayMode;
                        const rainyStart = r.schedule_data?.rainyDayStartTime;
                        totalCloudBunks += bunks;
                        const isMe = r.scheduler_id === userId ? ' ★YOU★' : '';
                        console.log(`  [${i + 1}] ${r.scheduler_name || 'Unknown'}${isMe}`);
                        console.log(`      Divisions: ${JSON.stringify(r.divisions)}`);
                        console.log(`      Bunks: ${bunks}, Slots: ${slots}`);
                        console.log(`      Rainy: ${isRainy}, StartTime: ${rainyStart}`);
                        console.log(`      Updated: ${r.updated_at}`);
                    });
                    console.log('');
                    console.log('Total cloud bunks:', totalCloudBunks);
                } else {
                    console.log('  ⚠️ NO RECORDS IN CLOUD!');
                    console.log('  Run: await verifiedScheduleSave()');
                }
            } catch (e) {
                console.log('Cloud query error:', e.message);
            }
        }
        console.log('');
        console.log('Quick Actions:');
        console.log('  await verifiedScheduleSave()        // Save with retry');
        console.log('  await forceLoadScheduleFromCloud()  // Load from cloud');
        console.log('  CloudPermissions.diagnose()         // Check permissions');
        console.log('═══════════════════════════════════════════════════════');
    };

    // =========================================================================
    // START
    // =========================================================================

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', waitForSystems);
    } else {
        setTimeout(waitForSystems, 300);
    }

    console.log('🔗 Campistry Integration Hooks v6.8 loaded');
    console.log('   Commands: diagnoseScheduleSync(), verifiedScheduleSave(), forceLoadScheduleFromCloud()');
    console.log('   v6.8: Scheduler role guard for camp_state + localStorage fallback hydration');

})();
