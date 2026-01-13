// =================================================================
// schedule_version_ui.js — Self-Mounting Version UI
// VERSION: v3.4 (403 HANDLING & QUIET MOUNT)
// =================================================================
//
// FIXES:
// 1. Handles 403 Forbidden errors gracefully (RLS policy violation)
// 2. Reduces retry noise in console
// 3. Targets #schedule tab correctly
//
// =================================================================
(function() {
    'use strict';

    console.log("📋 Schedule Version UI v3.4 (403 HANDLING) loading...");

    // =========================================================================
    // STATE
    // =========================================================================
    
    let currentVersionId = null;
    let isInitialized = false;
    let mountRetryCount = 0;
    const MAX_RETRIES = 20;

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
        if (toolbar) return toolbar;

        // TARGET SPECIFIC ELEMENTS FROM INDEX.HTML
        // Priority 1: Inside the #schedule tab, before the table
        const scheduleTable = document.getElementById('scheduleTable');
        
        // Priority 2: The #schedule tab itself (if table not ready)
        const scheduleTab = document.getElementById('schedule');
        
        let targetElement = null;
        let insertPosition = 'beforebegin';

        if (scheduleTable) {
            targetElement = scheduleTable;
            insertPosition = 'beforebegin';
        } else if (scheduleTab) {
            // Try to put it after the header div
            const header = scheduleTab.querySelector('div'); 
            if (header) {
                targetElement = header;
                insertPosition = 'afterend';
            } else {
                targetElement = scheduleTab;
                insertPosition = 'afterbegin';
            }
        }

        if (!targetElement) {
            // Only log sparingly to avoid console spam
            if (mountRetryCount === 0 || mountRetryCount === MAX_RETRIES - 1) { 
                console.log(`📋 Waiting for schedule container... (${mountRetryCount}/${MAX_RETRIES})`);
            }
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
                    font-family: system-ui, -apple-system, sans-serif;
                    width: 100%;
                    box-sizing: border-box;
                    color: white;
                }
                #schedule-version-toolbar .version-label {
                    color: #e0e0e0;
                    font-size: 14px;
                    white-space: nowrap;
                }
                #schedule-version-toolbar .version-name {
                    color: #4fc3f7;
                    font-weight: 600;
                    font-size: 14px;
                    padding: 6px 12px;
                    background: rgba(79, 195, 247, 0.15);
                    border-radius: 4px;
                    border: 1px solid rgba(79, 195, 247, 0.3);
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    max-width: 200px;
                }
                #schedule-version-toolbar button {
                    padding: 8px 16px;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 13px;
                    font-weight: 500;
                    transition: all 0.2s;
                    white-space: nowrap;
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
                @media (max-width: 600px) {
                    #schedule-version-toolbar {
                        flex-wrap: wrap;
                    }
                    #schedule-version-toolbar .spacer {
                        display: none;
                    }
                    #schedule-version-toolbar button {
                        flex: 1;
                        text-align: center;
                    }
                }
            </style>
            <span class="version-label">Version:</span>
            <span class="version-name" id="current-version-name">Unsaved</span>
            <div class="spacer"></div>
            <button class="btn-save-as" onclick="ScheduleVersionUI.saveAsNewVersion()">
                💾 Save As New Version
            </button>
            <button class="btn-versions" onclick="ScheduleVersionUI.openVersionsModal()">
                📂 History
            </button>
        `;

        targetElement.insertAdjacentElement(insertPosition, toolbar);
        console.log("📋 ✅ Toolbar mounted successfully");
        return toolbar;
    }

    // =========================================================================
    // VERSIONS MODAL
    // =========================================================================

    async function openVersionsModal() {
        const dateKey = getCurrentDateKey();
        
        let modal = document.getElementById('versions-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'versions-modal';
            document.body.appendChild(modal);
        }

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
                    font-family: system-ui, -apple-system, sans-serif;
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

        let versions = [];
        if (window.ScheduleVersionsDB) {
            versions = await window.ScheduleVersionsDB.listVersions(dateKey);
        } else {
            console.error("📋 ScheduleVersionsDB not loaded");
            alert("Database connection not ready. Please try again.");
            return;
        }

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
    // SAVE AS NEW VERSION
    // =========================================================================

    async function saveAsNewVersion() {
        const dateKey = getCurrentDateKey();
        let versions = [];
        
        if (window.ScheduleVersionsDB) {
            versions = await window.ScheduleVersionsDB.listVersions(dateKey);
        }
        
        const nextNum = versions.length + 1;
        const defaultName = `Schedule ${nextNum}`;
        const name = prompt(`Enter a name for this version:`, defaultName);
        
        if (!name) return;

        const scheduleData = getScheduleData();
        
        if (!window.ScheduleVersionsDB) {
            alert("❌ Versioning database not loaded.");
            return;
        }

        const result = await window.ScheduleVersionsDB.createVersion(
            dateKey,
            name,
            scheduleData,
            null 
        );

        if (result.success) {
            console.log("📋 ✅ Version saved:", result.version.id);
            await window.ScheduleVersionsDB.setActiveVersion(result.version.id);
            currentVersionId = result.version.id;
            updateToolbarDisplay(name);
            closeModal();
            alert(`✅ Saved as "${name}"`);
        } else {
            console.error("📋 ❌ Save failed:", result.error);
            // Enhanced error message for 403
            const errString = String(result.error);
            if (errString.includes('403') || errString.includes('security policy')) {
                alert(`🚫 Permission Denied\n\nYou do not have permission to create new schedule versions. This action is restricted to Camp Owners or Admins.\n\n(Error: Database 403 Forbidden)`);
            } else {
                alert(`❌ Failed to save: ${result.error}`);
            }
        }
    }

    // =========================================================================
    // BASE ON VERSION
    // =========================================================================

    async function baseOnVersion(sourceId, sourceName) {
        const newName = prompt(
            `Create a new version based on "${sourceName}":\n\nEnter name for the new version:`,
            `${sourceName} (copy)`
        );

        if (!newName) return;

        if (!window.ScheduleVersionsDB) {
            alert("❌ Versioning database not loaded.");
            return;
        }

        const result = await window.ScheduleVersionsDB.createBasedOn(sourceId, newName);

        if (result.success) {
            console.log("📋 ✅ Base On Complete");
            await useVersion(result.version.id);
            closeModal();
            alert(`✅ Created "${newName}" based on "${sourceName}"`);
        } else {
            console.error("📋 ❌ Base On failed:", result.error);
            const errString = String(result.error);
            if (errString.includes('403') || errString.includes('security policy')) {
                alert(`🚫 Permission Denied\n\nYou cannot create new versions. Check your role permissions.\n\n(Error: Database 403 Forbidden)`);
            } else {
                alert(`❌ Failed to create version: ${result.error}`);
            }
        }
    }

    // =========================================================================
    // USE VERSION
    // =========================================================================

    async function useVersion(versionId) {
        console.log("📋 Loading version:", versionId);

        if (!window.ScheduleVersionsDB) return;

        const version = await window.ScheduleVersionsDB.getVersion(versionId);
        if (!version) {
            alert("❌ Version not found.");
            return;
        }

        const dateKey = version.date;
        const data = version.schedule_data;

        // Update localStorage
        const dailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
        dailyData[dateKey] = data;
        localStorage.setItem('campDailyData_v1', JSON.stringify(dailyData));

        // Update window state
        window.scheduleAssignments = data.scheduleAssignments || {};
        window.unifiedTimes = data.unifiedTimes || [];
        if (data.skeleton) window.skeleton = data.skeleton;

        // Set active
        await window.ScheduleVersionsDB.setActiveVersion(versionId);
        currentVersionId = versionId;

        updateToolbarDisplay(version.name);
        
        // Refresh UI
        if (window.updateTable) window.updateTable();
        window.dispatchEvent(new CustomEvent('campistry-daily-data-updated'));

        closeModal();
    }

    // =========================================================================
    // DELETE VERSION
    // =========================================================================

    async function deleteVersion(versionId) {
        if (!confirm("Are you sure you want to delete this version?")) return;

        const result = await window.ScheduleVersionsDB.deleteVersion(versionId, true);
        
        if (result.success) {
            openVersionsModal();
        } else {
            alert("❌ Failed to delete: " + result.error);
        }
    }

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
        }
    }

    // =========================================================================
    // INIT
    // =========================================================================

    function init() {
        if (isInitialized) return;
        mountRetryCount++;

        const toolbar = createToolbar();
        if (!toolbar) {
            // Keep retrying for a while, but stop after max retries
            if (mountRetryCount < MAX_RETRIES) setTimeout(init, 500);
            return;
        }

        isInitialized = true;
        refreshToolbar();

        window.addEventListener('campistry-date-changed', refreshToolbar);
        document.getElementById('dateInput')?.addEventListener('change', refreshToolbar);

        console.log("📋 ✅ Schedule Version UI v3.4 initialized");
    }

    // Multiple init triggers for reliability
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(init, 500));
    } else {
        setTimeout(init, 500);
    }
    
    // Also try using MutationObserver to detect when schedule container appears
    const observer = new MutationObserver((mutations) => {
        if (!isInitialized) init();
    });
    observer.observe(document.body, { childList: true, subtree: true });

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

})();
