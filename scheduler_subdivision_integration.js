// ============================================================================
// scheduler_subdivision_integration.js (v1.4 - ROBUST MULTI-TENANT & MERGE SAFE)
// ============================================================================
// INTEGRATION LAYER: Connects SubdivisionScheduleManager with the scheduler
//
// UPDATE v1.4:
// - Added rigorous background division detection (Fixes "0 background detected" bug)
// - Improved logic to ensure optimizer sees all global constraints
// ============================================================================

(function() {
    'use strict';

    // =========================================================================
    // STATE
    // =========================================================================

    let _originalRunSkeletonOptimizer = null;
    let _isIntegrationActive = false;

    // =========================================================================
    // HOOKS
    // =========================================================================

    /**
     * Wrap the skeleton optimizer to add subdivision awareness
     */
    function installSchedulerHooks() {
        if (_isIntegrationActive) return;

        // Store original function
        _originalRunSkeletonOptimizer = window.runSkeletonOptimizer;

        // Replace with wrapped version
        window.runSkeletonOptimizer = async function(manualSkeleton, externalOverrides) {
            console.log('\n' + '='.repeat(70));
            console.log('★★★ MULTI-SCHEDULER MODE INITIALIZING ★★★');
            console.log('='.repeat(70));

            // 1. ROBUST INITIALIZATION CHECK
            let retries = 0;
            while (!window.SubdivisionScheduleManager && retries < 20) {
                console.log(`[Integration] Waiting for SubdivisionScheduleManager (Attempt ${retries+1}/20)...`);
                await new Promise(r => setTimeout(r, 100));
                retries++;
            }

            const manager = window.SubdivisionScheduleManager;
            if (!manager) {
                console.warn('[Integration] SubdivisionScheduleManager not available, running standard mode.');
                return _originalRunSkeletonOptimizer(manualSkeleton, externalOverrides);
            }

            // Ensure initialized
            if (manager.ensureInitialized) {
                await manager.ensureInitialized();
            } else if (!manager.isInitialized && manager.initialize) {
                await manager.initialize();
            }

            // 2. PREPARE MULTI-TENANT DATA
            
            // Get current user's divisions
            const divisionsToSchedule = manager.getDivisionsToSchedule();
            console.log(`[Integration] 🎯 Active Divisions: ${divisionsToSchedule.join(', ') || 'NONE'}`);

            // ★★★ IMPROVED BACKGROUND DETECTION ★★★
            // Do not rely solely on the manager's loaded subdivisions, check global authority
            let allDivisions = [];
            if (window.global_authority && window.global_authority.getAllDivisions) {
                allDivisions = window.global_authority.getAllDivisions();
            } else if (window.divisions) {
                allDivisions = Object.keys(window.divisions);
            }

            // Calculate background divisions (All - Mine)
            const backgroundDivisions = allDivisions.filter(d => !divisionsToSchedule.includes(d));
            
            // Get locked subdivisions info from manager
            const lockedSubs = manager.getOtherLockedSubdivisions();
            
            console.log(`[Integration] 🔒 Background Divisions (Calculated): ${backgroundDivisions.join(', ')}`);
            console.log(`[Integration] 🔒 Background Subdivisions (Loaded in Manager): ${lockedSubs.length}`);

            // If mismatch, warn but proceed (Manager usually loads everything, but global check is safer)
            if (backgroundDivisions.length > 0 && lockedSubs.length === 0) {
                console.warn("[Integration] ⚠️ WARNING: Background divisions exist but Manager reports 0 locked. Ensure cloud data is synced.");
            }

            // ★★★ CRITICAL: Get Snapshot of existing schedules for background divisions
            let scheduleSnapshot = null;
            if (manager.getLockedScheduleSnapshot) {
                scheduleSnapshot = manager.getLockedScheduleSnapshot();
                const snapshotCount = Object.keys(scheduleSnapshot).length;
                console.log(`[Integration] 📸 Captured snapshot of ${snapshotCount} locked bunks.`);
            } else {
                console.warn('[Integration] getLockedScheduleSnapshot not found on manager (old version?)');
            }

            // Register global field locks (Capacity constraints)
            if (manager.registerLockedClaimsInGlobalLocks) {
                manager.registerLockedClaimsInGlobalLocks();
            } else {
                // Fallback to legacy restore if new method missing
                manager.restoreLockedSchedules();
            }

            // 3. PRE-GENERATION EXTRAS (Smart Allocation)
            applySmartResourceAllocation(manager, divisionsToSchedule);

            // 4. FILTER SKELETON
            const filteredSkeleton = filterSkeletonByDivisions(manualSkeleton, divisionsToSchedule);
            console.log(`[Integration] 🧹 Filtered skeleton from ${manualSkeleton.length} to ${filteredSkeleton.length} items.`);

            // 5. EXECUTE CORE SCHEDULER
            // Pass extra args: allowedDivisions, scheduleSnapshot
            const result = _originalRunSkeletonOptimizer(
                filteredSkeleton, 
                externalOverrides, 
                divisionsToSchedule, 
                scheduleSnapshot
            );

            // 6. POST-GENERATION CLEANUP
            manager.markCurrentUserSubdivisionsAsDraft();
            
            // Clear temporary state
            delete window._currentSchedulingDivisions;
            delete window._smartResourceAllocation;

            console.log('[Integration] ✅ Schedule generation complete.');

            return result;
        };

        _isIntegrationActive = true;
        console.log('[Integration] Scheduler hooks installed for multi-scheduler support');
    }

    /**
     * Filter skeleton to only include divisions the user can edit
     */
    function filterSkeletonByDivisions(skeleton, allowedDivisions) {
        if (!allowedDivisions || allowedDivisions.length === 0) {
            console.warn('[Integration] No allowed divisions - returning empty skeleton');
            return [];
        }

        const allowedSet = new Set(allowedDivisions);
        
        return skeleton.filter(block => {
            // If block has no division, include it (camp-wide)
            if (!block.division) return true;
            
            // Otherwise only include if division is allowed
            return allowedSet.has(block.division);
        });
    }

    /**
     * Apply smart resource allocation
     * Adjusts solver behavior to leave room for other schedulers
     */
    function applySmartResourceAllocation(manager, divisionsToSchedule) {
        // Get all slots (assume first and last from unified times)
        const slots = window.unifiedTimes?.map((_, i) => i) || [];
        if (slots.length === 0) return;

        if (!manager.getSmartResourceAllocation) return;

        const allocation = manager.getSmartResourceAllocation(slots);
        
        // Store allocation for solver to use
        window._smartResourceAllocation = allocation;

        // Log recommendations
        const highDemandResources = Object.entries(allocation)
            .filter(([name, info]) => info.othersWaiting > 0 && info.fairShare < info.remaining)
            .map(([name, info]) => `${name}: use ${info.fairShare}/${info.remaining}`);

        if (highDemandResources.length > 0) {
            console.log('[Integration] Smart allocation recommendations:');
            highDemandResources.forEach(r => console.log(`  ${r}`));
        }
    }

    // =========================================================================
    // CAPACITY OVERRIDE HELPERS
    // =========================================================================

    /**
     * Get adjusted capacity for a field considering locked claims
     * Used by canBlockFit and solver
     */
    function getAdjustedFieldCapacity(fieldName, slots) {
        const manager = window.SubdivisionScheduleManager;
        if (!manager?.isInitialized) {
            return null; // No adjustment
        }

        if (manager.getRemainingFieldCapacity) {
            return manager.getRemainingFieldCapacity(fieldName, slots);
        }
        return null;
    }

    /**
     * Check if field is blocked by locked subdivision
     */
    function isFieldBlockedByLockedSubdivision(fieldName, slots, divisionContext) {
        const manager = window.SubdivisionScheduleManager;
        if (!manager?.isInitialized) {
            return false;
        }

        if (manager.isFieldClaimedByOthers) {
            const claimInfo = manager.isFieldClaimedByOthers(fieldName, slots, divisionContext);
            return claimInfo.claimed;
        }
        return false;
    }

    // =========================================================================
    // UI HELPERS
    // =========================================================================

    /**
     * Create lock/unlock button for a subdivision
     */
    function createLockButton(subdivisionId, onStateChange) {
        const manager = window.SubdivisionScheduleManager;
        if (!manager) return null;

        const schedule = manager.getSubdivisionSchedule(subdivisionId);
        if (!schedule) return null;

        const canEdit = manager.canEditSubdivision(subdivisionId);
        const isLocked = schedule.status === manager.SCHEDULE_STATUS.LOCKED;
        const isDraft = schedule.status === manager.SCHEDULE_STATUS.DRAFT;

        const btn = document.createElement('button');
        btn.className = `subdivision-lock-btn ${isLocked ? 'locked' : isDraft ? 'draft' : 'empty'}`;
        
        if (isLocked) {
            btn.innerHTML = '🔒 Locked';
            btn.disabled = !canEdit;
            btn.title = `Locked by ${schedule.lockedBy?.name || schedule.lockedBy?.email}`;
            
            btn.onclick = () => {
                if (confirm(`Unlock schedule for ${schedule.subdivisionName}? This will allow edits.`)) {
                    const result = manager.unlockSubdivisionSchedule(subdivisionId);
                    if (result.success && onStateChange) {
                        onStateChange(result.schedule);
                    } else if (!result.success) {
                        alert(result.error);
                    }
                }
            };
        } else if (isDraft) {
            btn.innerHTML = '🔓 Lock Schedule';
            btn.disabled = !canEdit;
            btn.title = 'Lock to prevent changes by others';
            
            btn.onclick = () => {
                if (confirm(`Lock schedule for ${schedule.subdivisionName}? Other schedulers will not be able to modify it.`)) {
                    const result = manager.lockSubdivisionSchedule(subdivisionId);
                    if (result.success && onStateChange) {
                        onStateChange(result.schedule);
                    } else if (!result.success) {
                        alert(result.error);
                    }
                }
            };
        } else {
            btn.innerHTML = '⬜ No Schedule';
            btn.disabled = true;
            btn.title = 'Generate a schedule first';
        }

        return btn;
    }

    /**
     * Create status panel showing all subdivision schedules
     */
    function createSubdivisionStatusPanel(container) {
        const manager = window.SubdivisionScheduleManager;
        if (!manager) {
            container.innerHTML = '<p>Subdivision manager not loaded</p>';
            return;
        }

        if (!manager.isInitialized) {
            container.innerHTML = '<p>Loading subdivision status...</p>';
            // Try to initialize
            manager.initialize?.().then(() => {
                createSubdivisionStatusPanel(container);
            });
            return;
        }

        const summary = manager.getSubdivisionStatusSummary();

        // Restore beautiful CSS from v1.1
        const html = `
            <style>
                .subdivision-status-panel {
                    background: #f8fafc;
                    border: 1px solid #e2e8f0;
                    border-radius: 12px;
                    padding: 16px;
                    margin-bottom: 16px;
                }
                .subdivision-status-header {
                    font-size: 1.1rem;
                    font-weight: 600;
                    color: #1e293b;
                    margin-bottom: 12px;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                .subdivision-status-list {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }
                .subdivision-status-item {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 12px 16px;
                    background: white;
                    border: 1px solid #e2e8f0;
                    border-radius: 8px;
                    transition: all 0.15s;
                }
                .subdivision-status-item:hover {
                    border-color: #cbd5e1;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.05);
                }
                .subdivision-status-item.is-mine {
                    border-left: 4px solid #3b82f6;
                }
                .subdivision-status-item.is-locked {
                    background: #fef3c7;
                    border-color: #f59e0b;
                }
                .subdivision-status-item.is-locked.is-mine {
                    border-left: 4px solid #f59e0b;
                }
                .subdivision-info {
                    flex: 1;
                }
                .subdivision-name {
                    font-weight: 600;
                    color: #1e293b;
                    margin-bottom: 2px;
                }
                .subdivision-divisions {
                    font-size: 0.85rem;
                    color: #64748b;
                }
                .subdivision-status-badge {
                    padding: 4px 10px;
                    border-radius: 999px;
                    font-size: 0.75rem;
                    font-weight: 600;
                    margin-right: 12px;
                }
                .badge-locked {
                    background: #fef3c7;
                    color: #92400e;
                }
                .badge-draft {
                    background: #dbeafe;
                    color: #1e40af;
                }
                .badge-empty {
                    background: #f1f5f9;
                    color: #64748b;
                }
                .subdivision-lock-btn {
                    padding: 8px 16px;
                    border-radius: 8px;
                    font-weight: 600;
                    font-size: 0.85rem;
                    cursor: pointer;
                    border: 1px solid;
                    transition: all 0.15s;
                }
                .subdivision-lock-btn.locked {
                    background: #fee2e2;
                    color: #b91c1c;
                    border-color: #fca5a5;
                }
                .subdivision-lock-btn.locked:hover:not(:disabled) {
                    background: #fecaca;
                }
                .subdivision-lock-btn.draft {
                    background: #22c55e;
                    color: white;
                    border-color: #16a34a;
                }
                .subdivision-lock-btn.draft:hover:not(:disabled) {
                    background: #16a34a;
                }
                .subdivision-lock-btn.empty {
                    background: #f1f5f9;
                    color: #94a3b8;
                    border-color: #e2e8f0;
                }
                .subdivision-lock-btn:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }
                .locked-info {
                    font-size: 0.75rem;
                    color: #b45309;
                    margin-top: 4px;
                }
            </style>
            
            <div class="subdivision-status-panel">
                <div class="subdivision-status-header">
                    📋 Schedule Status by Subdivision
                </div>
                <div class="subdivision-status-list" id="subdivision-status-list">
                    <!-- Items inserted dynamically -->
                </div>
            </div>
        `;

        container.innerHTML = html;
        const listEl = container.querySelector('#subdivision-status-list');

        if (!summary || summary.length === 0) {
            listEl.innerHTML = '<p style="color:#64748b;padding:8px;">No subdivisions configured yet.</p>';
            return;
        }

        summary.forEach(sub => {
            const item = document.createElement('div');
            item.className = `subdivision-status-item ${sub.isMySubdivision ? 'is-mine' : ''} ${sub.status === 'locked' ? 'is-locked' : ''}`;

            const statusBadge = sub.status === 'locked' ? 'badge-locked' :
                               sub.status === 'draft' ? 'badge-draft' : 'badge-empty';
            
            const statusText = sub.status === 'locked' ? '🔒 Locked' :
                              sub.status === 'draft' ? '📝 Draft' : '⬜ Empty';

            item.innerHTML = `
                <div class="subdivision-info">
                    <div class="subdivision-name">${sub.name} ${sub.isMySubdivision ? '(Your subdivision)' : ''}</div>
                    <div class="subdivision-divisions">${sub.divisions.join(', ')}</div>
                    ${sub.lockedBy ? `<div class="locked-info">Locked by ${sub.lockedBy.name || sub.lockedBy.email} at ${new Date(sub.lockedAt).toLocaleString()}</div>` : ''}
                </div>
                <span class="subdivision-status-badge ${statusBadge}">${statusText}</span>
                <div class="subdivision-actions" id="actions-${sub.id}"></div>
            `;

            listEl.appendChild(item);

            // Add lock/unlock button
            const actionsEl = item.querySelector(`#actions-${sub.id}`);
            const btn = createLockButton(sub.id, () => {
                // Refresh the panel on state change
                createSubdivisionStatusPanel(container);
            });
            if (btn) actionsEl.appendChild(btn);
        });
    }

    // =========================================================================
    // BUNK EDIT PROTECTION
    // =========================================================================

    /**
     * Check if a bunk can be edited by current user
     */
    function canEditBunk(bunkName) {
        const manager = window.SubdivisionScheduleManager;
        if (!manager?.isInitialized) {
            return true; // Allow if manager not ready
        }

        // Check if bunk belongs to a locked subdivision
        if (manager.isBunkLocked(bunkName)) {
            return false;
        }

        // Check if user has access to this bunk's division
        const allDivisions = window.divisions || {};
        for (const [divName, divInfo] of Object.entries(allDivisions)) {
            if (divInfo.bunks?.includes(bunkName)) {
                return manager.canEditDivision(divName);
            }
        }

        return false;
    }

    /**
     * Get edit status for a bunk (for UI display)
     */
    function getBunkEditStatus(bunkName) {
        const manager = window.SubdivisionScheduleManager;
        
        if (!manager?.isInitialized) {
            return { canEdit: true, reason: null };
        }

        // Find bunk's division
        const allDivisions = window.divisions || {};
        let bunkDivision = null;
        
        for (const [divName, divInfo] of Object.entries(allDivisions)) {
            if (divInfo.bunks?.includes(bunkName)) {
                bunkDivision = divName;
                break;
            }
        }

        if (!bunkDivision) {
            return { canEdit: false, reason: 'Bunk not found in any division' };
        }

        const lockStatus = manager.getDivisionLockStatus(bunkDivision);

        if (lockStatus.isLocked) {
            return { 
                canEdit: false, 
                reason: `Schedule locked: ${lockStatus.message}`,
                isLocked: true,
                lockedBy: lockStatus.lockedBy
            };
        }

        if (!lockStatus.canEdit) {
            return { 
                canEdit: false, 
                reason: 'You do not have permission to edit this division',
                noPermission: true
            };
        }

        return { canEdit: true, reason: null };
    }

    // =========================================================================
    // AUTO-INITIALIZATION
    // =========================================================================

    /**
     * Auto-initialize when document is ready
     */
    function autoInit() {
        // Install scheduler hooks
        installSchedulerHooks();

        // FIXED: isInitialized is a getter property, not a function
        if (window.AccessControl?.isInitialized) {
            window.SubdivisionScheduleManager?.initialize?.();
        } else {
            // Wait for AccessControl
            const checkInterval = setInterval(() => {
                if (window.AccessControl?.isInitialized) {
                    clearInterval(checkInterval);
                    window.SubdivisionScheduleManager?.initialize?.();
                }
            }, 200);

            // Timeout after 30 seconds
            setTimeout(() => clearInterval(checkInterval), 30000);
        }
    }

    // Run auto-init when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', autoInit);
    } else {
        // Small delay to ensure other modules are loaded
        setTimeout(autoInit, 100);
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    window.SchedulerSubdivisionIntegration = {
        // Hooks
        installSchedulerHooks,
        
        // Capacity helpers
        getAdjustedFieldCapacity,
        isFieldBlockedByLockedSubdivision,

        // Edit protection
        canEditBunk,
        getBunkEditStatus,

        // UI
        createLockButton,
        createSubdivisionStatusPanel,

        // Utilities
        filterSkeletonByDivisions
    };

    console.log('[SchedulerSubdivisionIntegration] Module loaded v1.4 (ROBUST MULTI-TENANT)');

})();
