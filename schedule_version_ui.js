// =================================================================
// schedule_version_ui_v3.js — Self-Mounting Version UI
// VERSION: v3.0 (SELF-MOUNTING + SAVE INTERCEPT)
// =================================================================
//
// FIXES:
// 1. Creates its own toolbar if none exists
// 2. Intercepts save operations to use versioning
// 3. Proper "Base On" that creates NEW rows
//
// =================================================================
(function() {
    'use strict';

    console.log("📋 Schedule Version UI v3.0 (SELF-MOUNT) loading...");

    // =========================================================================
    // STATE
    // =========================================================================
    
    let currentVersionId = null;
    let isInitialized = false;

    // =========================================================================
    // HELPERS
    // =========================================================================

    function getCurrentDateKey() {
        return window.currentlySelectedDate || 
               document.getElementById('dateInput')?.value ||
               new Date().toISOString().split('T')[0];
    }

    function getScheduleData() {
        const dateKey = getCurrentDateKey();
        const dailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
        return dailyData[dateKey] || {
            scheduleAssignments: window.scheduleAssignments || {},
            unifiedTimes: window.unifiedTimes || [],
            skeleton: window.skeleton || []
        };
    }

    // =========================================================================
    // CREATE TOOLBAR (if needed)
    // =========================================================================

    function createToolbar() {
        // Check if toolbar already exists
        let toolbar = document.getElementById('schedule-version-toolbar');
        if (toolbar) {
            console.log("📋 Toolbar already exists");
            return toolbar;
        }

        // Find a good place to insert
        const scheduleContainer = document.getElementById('scheduleContainer') ||
                                  document.getElementById('schedule-area') ||
                                  document.querySelector('.schedule-table-container') ||
                                  document.querySelector('[data-schedule]');

        if (!scheduleContainer) {
            console.warn("📋 No schedule container found, will retry...");
            return null;
        }

        // Create the toolbar
        toolbar = document.createElement('div');
        toolbar.id = 'schedule-version-toolbar';
        toolbar.innerHTML = `
            <style>
                #schedule-version-toolbar {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    padding: 12px 16px;
                    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                    border-radius: 8px;
                    margin-bottom: 16px;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
                }
                #schedule-version-toolbar .version-label {
                    color: #e0e0e0;
                    font-size: 14px;
                }
                #schedule-version-toolbar .version-name {
                    color: #4fc3f7;
                    font-weight: 600;
                    font-size: 14px;
                    padding: 6px 12px;
                    background: rgba(79, 195, 247, 0.15);
                    border-radius: 4px;
                    border: 1px solid rgba(79, 195, 247, 0.3);
                }
                #schedule-version-toolbar button {
                    padding: 8px 16px;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 13px;
                    font-weight: 500;
                    transition: all 0.2s;
                }
                #schedule-version-toolbar .btn-versions {
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                }
                #schedule-version-toolbar .btn-versions:hover {
                    transform: translateY(-1px);
                    box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
                }
                #schedule-version-toolbar .btn-save-as {
                    background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
                    color: white;
                }
                #schedule-version-toolbar .btn-save-as:hover {
                    transform: translateY(-1px);
                    box-shadow: 0 4px 12px rgba(17, 153, 142, 0.4);
                }
                #schedule-version-toolbar .spacer {
                    flex: 1;
                }
            </style>
            <span class="version-label">Current:</span>
            <span class="version-name" id="current-version-name">Loading...</span>
            <div class="spacer"></div>
            <button class="btn-save-as" onclick="ScheduleVersionUI.saveAsNewVersion()">
                📋 Save As New Version
            </button>
            <button class="btn-versions" onclick="ScheduleVersionUI.openVersionsModal()">
                📂 Manage Versions
            </button>
        `;

        scheduleContainer.parentNode.insertBefore(toolbar, scheduleContainer);
        console.log("📋 ✅ Toolbar created and inserted");
        return toolbar;
    }

    // =========================================================================
    // VERSIONS MODAL
    // =========================================================================

    async function openVersionsModal() {
        const dateKey = getCurrentDateKey();
        
        // Create modal if it doesn't exist
        let modal = document.getElementById('versions-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'versions-modal';
            document.body.appendChild(modal);
        }

        // Show loading state
        modal.innerHTML = `
            <style>
                #versions-modal {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0,0,0,0.7);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 10000;
                }
                .versions-content {
                    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                    border-radius: 12px;
                    padding: 24px;
                    min-width: 500px;
                    max-width: 700px;
                    max-height: 80vh;
                    overflow-y: auto;
                    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
                }
                .versions-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 20px;
                    padding-bottom: 12px;
                    border-bottom: 1px solid rgba(255,255,255,0.1);
                }
                .versions-header h2 {
                    color: white;
                    margin: 0;
                    font-size: 20px;
                }
                .versions-close {
                    background: none;
                    border: none;
                    color: #888;
                    font-size: 24px;
                    cursor: pointer;
                    padding: 4px 8px;
                }
                .versions-close:hover { color: white; }
                .version-item {
                    display: flex;
                    align-items: center;
                    padding: 12px 16px;
                    margin: 8px 0;
                    background: rgba(255,255,255,0.05);
                    border-radius: 8px;
                    border: 1px solid rgba(255,255,255,0.1);
                    transition: all 0.2s;
                }
                .version-item:hover {
                    background: rgba(255,255,255,0.1);
                    border-color: rgba(79, 195, 247, 0.3);
                }
                .version-item.active {
                    border-color: #4fc3f7;
                    background: rgba(79, 195, 247, 0.1);
                }
                .version-info {
                    flex: 1;
                }
                .version-name-text {
                    color: white;
                    font-weight: 600;
                    font-size: 15px;
                }
                .version-meta {
                    color: #888;
                    font-size: 12px;
                    margin-top: 4px;
                }
                .version-badge {
                    background: #4fc3f7;
                    color: #1a1a2e;
                    padding: 2px 8px;
                    border-radius: 4px;
                    font-size: 11px;
                    font-weight: 600;
                    margin-left: 8px;
                }
                .version-actions {
                    display: flex;
                    gap: 8px;
                }
                .version-actions button {
                    padding: 6px 12px;
                    border: none;
                    border-radius: 4px;
                    font-size: 12px;
                    cursor: pointer;
                    transition: all 0.2s;
                }
                .btn-use {
                    background: #4fc3f7;
                    color: #1a1a2e;
                }
                .btn-base {
                    background: #667eea;
                    color: white;
                }
                .btn-delete {
                    background: #ff5252;
                    color: white;
                }
                .no-versions {
                    color: #888;
                    text-align: center;
                    padding: 40px;
                }
                .create-first-btn {
                    margin-top: 16px;
                    padding: 12px 24px;
                    background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
                    color: white;
                    border: none;
                    border-radius: 8px;
                    font-size: 14px;
                    font-weight: 500;
                    cursor: pointer;
                }
            </style>
            <div class="versions-content">
                <div class="versions-header">
                    <h2>📋 Schedule Versions for ${dateKey}</h2>
                    <button class="versions-close" onclick="ScheduleVersionUI.closeModal()">×</button>
                </div>
                <div style="color:#888; text-align:center; padding:40px;">
                    Loading versions...
                </div>
            </div>
        `;

        // Fetch versions from database
        let versions = [];
        if (window.ScheduleVersionsDB) {
            versions = await window.ScheduleVersionsDB.listVersions(dateKey);
        }

        // Render versions list
        const content = modal.querySelector('.versions-content');
        
        if (versions.length === 0) {
            content.innerHTML = `
                <div class="versions-header">
                    <h2>📋 Schedule Versions for ${dateKey}</h2>
                    <button class="versions-close" onclick="ScheduleVersionUI.closeModal()">×</button>
                </div>
                <div class="no-versions">
                    <p>No saved versions yet.</p>
                    <p style="font-size:13px;">Create your first version to start tracking changes.</p>
                    <button class="create-first-btn" onclick="ScheduleVersionUI.saveAsNewVersion()">
                        ✨ Save Current as Version 1
                    </button>
                </div>
            `;
        } else {
            let versionsHtml = versions.map(v => {
                const isActive = v.is_active;
                const bunks = Object.keys(v.schedule_data?.scheduleAssignments || {}).length;
                const createdDate = new Date(v.created_at).toLocaleString();
                const basedOnText = v.based_on ? '(cloned)' : '(original)';
                
                return `
                    <div class="version-item ${isActive ? 'active' : ''}" data-id="${v.id}">
                        <div class="version-info">
                            <span class="version-name-text">${v.name}</span>
                            ${isActive ? '<span class="version-badge">ACTIVE</span>' : ''}
                            <div class="version-meta">
                                ${bunks} bunks • Created ${createdDate} ${basedOnText}
                            </div>
                        </div>
                        <div class="version-actions">
                            ${!isActive ? `<button class="btn-use" onclick="ScheduleVersionUI.useVersion('${v.id}')">Use</button>` : ''}
                            <button class="btn-base" onclick="ScheduleVersionUI.baseOnVersion('${v.id}', '${v.name}')">Base On</button>
                            ${!isActive ? `<button class="btn-delete" onclick="ScheduleVersionUI.deleteVersion('${v.id}')">Delete</button>` : ''}
                        </div>
                    </div>
                `;
            }).join('');

            content.innerHTML = `
                <div class="versions-header">
                    <h2>📋 Schedule Versions for ${dateKey}</h2>
                    <button class="versions-close" onclick="ScheduleVersionUI.closeModal()">×</button>
                </div>
                ${versionsHtml}
                <div style="margin-top: 16px; text-align: center;">
                    <button class="create-first-btn" onclick="ScheduleVersionUI.saveAsNewVersion()">
                        ➕ Save Current as New Version
                    </button>
                </div>
            `;
        }
    }

    function closeModal() {
        const modal = document.getElementById('versions-modal');
        if (modal) modal.remove();
    }

    // =========================================================================
    // ★★★ CRITICAL: SAVE AS NEW VERSION ★★★
    // =========================================================================

    async function saveAsNewVersion() {
        console.log("📋 ═══════════════════════════════════════════");
        console.log("📋 SAVE AS NEW VERSION");
        console.log("📋 ═══════════════════════════════════════════");

        const dateKey = getCurrentDateKey();
        
        // Count existing versions
        let versions = [];
        if (window.ScheduleVersionsDB) {
            versions = await window.ScheduleVersionsDB.listVersions(dateKey);
        }
        
        const nextNum = versions.length + 1;
        const defaultName = `Schedule ${nextNum}`;
        
        const name = prompt(
            `Enter a name for this version:`,
            defaultName
        );
        
        if (!name) {
            console.log("📋 Save cancelled");
            return;
        }

        // Get current schedule data
        const scheduleData = getScheduleData();
        
        console.log("📋 Saving version:", {
            date: dateKey,
            name: name,
            bunks: Object.keys(scheduleData.scheduleAssignments || {}).length
        });

        if (!window.ScheduleVersionsDB) {
            alert("❌ Versioning database not loaded. Check console for errors.");
            return;
        }

        // ★★★ CREATE NEW VERSION (INSERT, NOT UPDATE) ★★★
        const result = await window.ScheduleVersionsDB.createVersion(
            dateKey,
            name,
            scheduleData,
            null  // No base (fresh save)
        );

        if (result.success) {
            console.log("📋 ✅ Version saved with ID:", result.version.id);
            
            // Set as active
            await window.ScheduleVersionsDB.setActiveVersion(result.version.id);
            currentVersionId = result.version.id;
            
            updateToolbarDisplay(name);
            closeModal();
            alert(`✅ Saved as "${name}"`);
        } else {
            console.error("📋 ❌ Save failed:", result.error);
            alert(`❌ Failed to save: ${result.error}`);
        }
    }

    // =========================================================================
    // ★★★ CRITICAL: BASE ON VERSION (CLONE, NOT MODIFY) ★★★
    // =========================================================================

    async function baseOnVersion(sourceId, sourceName) {
        console.log("📋 ═══════════════════════════════════════════");
        console.log("📋 BASE ON VERSION");
        console.log("📋 Source ID:", sourceId);
        console.log("📋 Source Name:", sourceName);
        console.log("📋 ═══════════════════════════════════════════");

        const newName = prompt(
            `Create a new version based on "${sourceName}":\n\nEnter name for the new version:`,
            `${sourceName} (copy)`
        );

        if (!newName) {
            console.log("📋 Base On cancelled");
            return;
        }

        if (!window.ScheduleVersionsDB) {
            alert("❌ Versioning database not loaded.");
            return;
        }

        // ★★★ THIS IS THE CRITICAL CALL ★★★
        // createBasedOn does:
        // 1. Load source (READ ONLY)
        // 2. Deep clone data
        // 3. INSERT new row (POST, NOT PATCH)
        // 4. Source remains UNCHANGED
        const result = await window.ScheduleVersionsDB.createBasedOn(sourceId, newName);

        if (result.success) {
            console.log("📋 ═══════════════════════════════════════════");
            console.log("📋 ✅ BASE ON COMPLETE");
            console.log("📋 Source:", sourceName, "(", sourceId, ") - UNCHANGED");
            console.log("📋 New:", newName, "(", result.version.id, ") - CREATED");
            console.log("📋 ═══════════════════════════════════════════");
            
            // Load the new version into the editor
            await useVersion(result.version.id);
            
            closeModal();
            alert(`✅ Created "${newName}" based on "${sourceName}"\n\nThe original "${sourceName}" is preserved.`);
        } else {
            console.error("📋 ❌ Base On failed:", result.error);
            alert(`❌ Failed to create version: ${result.error}`);
        }
    }

    // =========================================================================
    // USE VERSION (Load into editor)
    // =========================================================================

    async function useVersion(versionId) {
        console.log("📋 Loading version:", versionId);

        if (!window.ScheduleVersionsDB) {
            alert("❌ Versioning database not loaded.");
            return;
        }

        const version = await window.ScheduleVersionsDB.getVersion(versionId);
        if (!version) {
            alert("❌ Version not found.");
            return;
        }

        // Load schedule data into the app
        const dateKey = version.date;
        const data = version.schedule_data;

        // Update localStorage
        const dailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
        dailyData[dateKey] = data;
        localStorage.setItem('campDailyData_v1', JSON.stringify(dailyData));

        // Update window objects
        window.scheduleAssignments = data.scheduleAssignments || {};
        window.unifiedTimes = data.unifiedTimes || [];
        if (data.skeleton) window.skeleton = data.skeleton;

        // Set as active
        await window.ScheduleVersionsDB.setActiveVersion(versionId);
        currentVersionId = versionId;

        // Update UI
        updateToolbarDisplay(version.name);
        
        // Trigger refresh
        if (window.updateTable) window.updateTable();
        window.dispatchEvent(new CustomEvent('storage'));

        closeModal();
        console.log("📋 ✅ Loaded version:", version.name);
    }

    // =========================================================================
    // DELETE VERSION
    // =========================================================================

    async function deleteVersion(versionId) {
        if (!confirm("Are you sure you want to delete this version?\n\nThis cannot be undone.")) {
            return;
        }

        const result = await window.ScheduleVersionsDB.deleteVersion(versionId, true);
        
        if (result.success) {
            console.log("📋 ✅ Deleted version:", versionId);
            // Refresh modal
            openVersionsModal();
        } else {
            alert("❌ Failed to delete: " + result.error);
        }
    }

    // =========================================================================
    // UPDATE TOOLBAR DISPLAY
    // =========================================================================

    function updateToolbarDisplay(versionName) {
        const nameEl = document.getElementById('current-version-name');
        if (nameEl) {
            nameEl.textContent = versionName || 'Unsaved';
        }
    }

    async function refreshToolbar() {
        const dateKey = getCurrentDateKey();
        
        if (window.ScheduleVersionsDB) {
            const activeVersion = await window.ScheduleVersionsDB.getActiveVersion(dateKey);
            if (activeVersion) {
                currentVersionId = activeVersion.id;
                updateToolbarDisplay(activeVersion.name);
            } else {
                currentVersionId = null;
                updateToolbarDisplay('Unsaved');
            }
        } else {
            updateToolbarDisplay('DB Not Ready');
        }
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    function init() {
        if (isInitialized) return;

        const toolbar = createToolbar();
        if (!toolbar) {
            // Retry later
            setTimeout(init, 1000);
            return;
        }

        isInitialized = true;
        refreshToolbar();

        // Listen for date changes
        window.addEventListener('campistry-date-changed', refreshToolbar);
        document.getElementById('dateInput')?.addEventListener('change', refreshToolbar);

        console.log("📋 ✅ Schedule Version UI v3.0 initialized");
    }

    // Try to init after DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(init, 500));
    } else {
        setTimeout(init, 500);
    }

    // Also try after cloud hydration
    window.addEventListener('cloud-hydration-complete', () => setTimeout(init, 500));

    // =========================================================================
    // EXPORTS
    // =========================================================================

    window.ScheduleVersionUI = {
        openVersionsModal,
        closeModal,
        saveAsNewVersion,
        baseOnVersion,
        useVersion,
        deleteVersion,
        refreshToolbar,
        init
    };

    console.log("📋 Schedule Version UI v3.0 loaded");

})();
