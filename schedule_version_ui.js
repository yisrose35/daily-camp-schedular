/**
 * Schedule Version UI v4.0 - AGGRESSIVE MOUNT
 * 
 * Finds actual schedule elements and mounts toolbar above them.
 * Falls back to floating toolbar if no container found.
 */
(function() {
    'use strict';
    
    console.log("📋 Schedule Version UI v4.0 (AGGRESSIVE MOUNT) loading...");
    
    let toolbar = null;
    let currentVersionId = null;
    let currentVersionName = 'Unsaved Draft';
    let initAttempts = 0;
    const MAX_INIT_ATTEMPTS = 50;
    
    // =============================================
    // TOOLBAR CREATION - AGGRESSIVE SELECTOR
    // =============================================
    
    function findMountPoint() {
        // Priority list of selectors - try many options
        const selectors = [
            // Common schedule containers
            '#scheduleContainer',
            '#schedule-container',
            '#schedule-area',
            '#schedule',
            '.schedule-container',
            '.schedule-area',
            '.schedule-table-container',
            
            // Staggered view containers (from your scheduler_ui.js)
            '#staggered-container',
            '.staggered-container',
            '#staggered-view',
            '.staggered-view',
            
            // Grade/division containers
            '.grade-container',
            '.division-container',
            '[data-division]',
            '[data-grade]',
            
            // Generic table containers
            '.schedule-tables',
            '.tables-container',
            '#tables',
            
            // App content areas
            '#app-content',
            '#main-content',
            '.main-content',
            '#scheduler-content',
            '.scheduler-content',
            '#content',
            'main',
            
            // Fallback: find any element that contains schedule tables
            '[class*="schedule"]',
            '[id*="schedule"]',
        ];
        
        for (const selector of selectors) {
            const el = document.querySelector(selector);
            if (el) {
                console.log(`📋 Found mount point: ${selector}`);
                return el;
            }
        }
        
        // Try to find the first table that looks like a schedule
        const tables = document.querySelectorAll('table');
        for (const table of tables) {
            // Look for tables with time-related headers or schedule-like content
            const text = table.textContent || '';
            if (text.includes('AM') || text.includes('PM') || 
                text.includes(':00') || text.includes('Slot') ||
                table.closest('[class*="grade"]') ||
                table.closest('[class*="division"]')) {
                console.log('📋 Found schedule table, using parent');
                return table.parentElement;
            }
        }
        
        return null;
    }
    
    function createToolbar() {
        if (toolbar && document.contains(toolbar)) {
            return toolbar;
        }
        
        let mountPoint = findMountPoint();
        
        // If no mount point, create floating toolbar
        const useFloating = !mountPoint;
        
        if (!mountPoint) {
            console.log("📋 No container found, using floating toolbar");
            mountPoint = document.body;
        }
        
        // Create the toolbar
        toolbar = document.createElement('div');
        toolbar.id = 'schedule-version-toolbar';
        
        const floatingStyles = useFloating ? `
            position: fixed;
            top: 10px;
            right: 10px;
            z-index: 10000;
        ` : `
            margin-bottom: 16px;
        `;
        
        toolbar.innerHTML = `
            <style>
                #schedule-version-toolbar {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    padding: 12px 16px;
                    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                    border-radius: 8px;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
                    ${floatingStyles}
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
                
                /* Modal styles */
                .version-modal-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0,0,0,0.7);
                    z-index: 100000;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                .version-modal {
                    background: #1e1e2e;
                    border-radius: 12px;
                    padding: 24px;
                    min-width: 400px;
                    max-width: 600px;
                    max-height: 80vh;
                    overflow-y: auto;
                    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
                }
                .version-modal h2 {
                    color: #fff;
                    margin: 0 0 20px 0;
                    font-size: 20px;
                }
                .version-modal .close-btn {
                    position: absolute;
                    top: 12px;
                    right: 12px;
                    background: none;
                    border: none;
                    color: #888;
                    font-size: 24px;
                    cursor: pointer;
                }
                .version-list {
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                }
                .version-item {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    padding: 12px;
                    background: rgba(255,255,255,0.05);
                    border-radius: 8px;
                    border: 1px solid rgba(255,255,255,0.1);
                }
                .version-item.active {
                    border-color: #4fc3f7;
                    background: rgba(79, 195, 247, 0.1);
                }
                .version-item .version-info {
                    flex: 1;
                }
                .version-item .version-info h3 {
                    color: #fff;
                    margin: 0 0 4px 0;
                    font-size: 15px;
                }
                .version-item .version-info p {
                    color: #888;
                    margin: 0;
                    font-size: 12px;
                }
                .version-item .version-actions {
                    display: flex;
                    gap: 8px;
                }
                .version-item button {
                    padding: 6px 12px;
                    border: none;
                    border-radius: 4px;
                    font-size: 12px;
                    cursor: pointer;
                }
                .version-item .btn-use {
                    background: #4fc3f7;
                    color: #000;
                }
                .version-item .btn-base {
                    background: #ff9800;
                    color: #000;
                }
                .version-item .btn-delete {
                    background: #f44336;
                    color: #fff;
                }
                .no-versions {
                    color: #888;
                    text-align: center;
                    padding: 40px;
                }
            </style>
            
            <span class="version-label">📋 Version:</span>
            <span class="version-name" id="current-version-name">${currentVersionName}</span>
            <div class="spacer"></div>
            <button class="btn-save-as" onclick="window.ScheduleVersionUI.saveAsNewVersion()">
                💾 Save As New Version
            </button>
            <button class="btn-versions" onclick="window.ScheduleVersionUI.showVersionsModal()">
                📚 Manage Versions
            </button>
        `;
        
        // Insert toolbar
        if (useFloating) {
            document.body.appendChild(toolbar);
        } else {
            mountPoint.insertBefore(toolbar, mountPoint.firstChild);
        }
        
        console.log("📋 Toolbar mounted successfully" + (useFloating ? " (floating)" : ""));
        return toolbar;
    }
    
    // =============================================
    // VERSION OPERATIONS
    // =============================================
    
    function getCurrentDate() {
        const selectedDate = window.selectedDate || localStorage.getItem('selectedDate');
        if (selectedDate) return selectedDate;
        
        const today = new Date();
        return today.toISOString().split('T')[0];
    }
    
    function getCampId() {
        return window.currentCampId || localStorage.getItem('currentCampId');
    }
    
    function getCurrentScheduleData() {
        const date = getCurrentDate();
        const dateKey = `schedules_${date}`;
        const stored = localStorage.getItem(dateKey);
        
        if (stored) {
            try {
                return JSON.parse(stored);
            } catch (e) {
                console.error('📋 Failed to parse schedule data:', e);
            }
        }
        
        // Fallback to window data
        return {
            assignments: window.scheduleAssignments || {},
            skeleton: window.skeleton || [],
            unifiedTimes: window.unifiedTimes || []
        };
    }
    
    async function saveAsNewVersion() {
        const name = prompt('Enter a name for this version:', `Schedule ${new Date().toLocaleString()}`);
        if (!name) return;
        
        const campId = getCampId();
        const date = getCurrentDate();
        const data = getCurrentScheduleData();
        
        if (!campId) {
            alert('Error: Camp ID not found. Please refresh the page.');
            return;
        }
        
        console.log("📋 Saving new version:", name);
        
        try {
            // Use the database module if available
            if (window.ScheduleVersionsDB) {
                const result = await window.ScheduleVersionsDB.createVersion(campId, date, name, data);
                if (result) {
                    currentVersionId = result.id;
                    currentVersionName = name;
                    updateToolbarDisplay();
                    alert(`✅ Version "${name}" saved successfully!`);
                }
            } else {
                // Fallback to localStorage
                const versions = JSON.parse(localStorage.getItem('schedule_versions') || '{}');
                const key = `${campId}_${date}`;
                if (!versions[key]) versions[key] = [];
                
                const version = {
                    id: Date.now().toString(),
                    name,
                    date,
                    campId,
                    data,
                    createdAt: new Date().toISOString()
                };
                
                versions[key].push(version);
                localStorage.setItem('schedule_versions', JSON.stringify(versions));
                
                currentVersionId = version.id;
                currentVersionName = name;
                updateToolbarDisplay();
                alert(`✅ Version "${name}" saved locally!`);
            }
        } catch (err) {
            console.error('📋 Save failed:', err);
            alert('❌ Failed to save version: ' + err.message);
        }
    }
    
    async function showVersionsModal() {
        const campId = getCampId();
        const date = getCurrentDate();
        
        let versions = [];
        
        try {
            if (window.ScheduleVersionsDB) {
                versions = await window.ScheduleVersionsDB.listVersions(campId, date);
            } else {
                const stored = JSON.parse(localStorage.getItem('schedule_versions') || '{}');
                const key = `${campId}_${date}`;
                versions = stored[key] || [];
            }
        } catch (err) {
            console.error('📋 Failed to load versions:', err);
        }
        
        const overlay = document.createElement('div');
        overlay.className = 'version-modal-overlay';
        overlay.onclick = (e) => {
            if (e.target === overlay) overlay.remove();
        };
        
        let versionListHTML = '';
        
        if (versions.length === 0) {
            versionListHTML = '<div class="no-versions">No saved versions for this date.<br>Click "Save As New Version" to create one.</div>';
        } else {
            versions.forEach(v => {
                const isActive = v.id === currentVersionId;
                const createdDate = new Date(v.created_at || v.createdAt).toLocaleString();
                const bunkCount = v.bunk_count || (v.data?.assignments ? Object.keys(v.data.assignments).length : 0);
                
                versionListHTML += `
                    <div class="version-item ${isActive ? 'active' : ''}">
                        <div class="version-info">
                            <h3>${v.name || v.version_name}${isActive ? ' ✓' : ''}</h3>
                            <p>Created: ${createdDate} • ${bunkCount} bunks</p>
                            ${v.based_on_name ? `<p>Based on: ${v.based_on_name}</p>` : ''}
                        </div>
                        <div class="version-actions">
                            ${!isActive ? `<button class="btn-use" onclick="window.ScheduleVersionUI.useVersion('${v.id}')">Use</button>` : ''}
                            <button class="btn-base" onclick="window.ScheduleVersionUI.baseOnVersion('${v.id}', '${(v.name || v.version_name).replace(/'/g, "\\'")}')">Base On</button>
                            <button class="btn-delete" onclick="window.ScheduleVersionUI.deleteVersion('${v.id}')">Delete</button>
                        </div>
                    </div>
                `;
            });
        }
        
        overlay.innerHTML = `
            <div class="version-modal" style="position: relative;">
                <button class="close-btn" onclick="this.closest('.version-modal-overlay').remove()">×</button>
                <h2>📚 Schedule Versions for ${date}</h2>
                <div class="version-list">
                    ${versionListHTML}
                </div>
            </div>
        `;
        
        document.body.appendChild(overlay);
    }
    
    async function useVersion(versionId) {
        console.log("📋 Loading version:", versionId);
        
        try {
            let versionData;
            
            if (window.ScheduleVersionsDB) {
                versionData = await window.ScheduleVersionsDB.getVersion(versionId);
            } else {
                const stored = JSON.parse(localStorage.getItem('schedule_versions') || '{}');
                for (const key in stored) {
                    const found = stored[key].find(v => v.id === versionId);
                    if (found) {
                        versionData = found;
                        break;
                    }
                }
            }
            
            if (!versionData) {
                alert('Version not found');
                return;
            }
            
            // Load the data
            const data = versionData.schedule_data || versionData.data;
            const date = versionData.schedule_date || versionData.date;
            
            if (data.assignments) {
                window.scheduleAssignments = data.assignments;
            }
            if (data.skeleton) {
                window.skeleton = data.skeleton;
            }
            if (data.unifiedTimes) {
                window.unifiedTimes = data.unifiedTimes;
            }
            
            // Save to localStorage
            const dateKey = `schedules_${date}`;
            localStorage.setItem(dateKey, JSON.stringify(data));
            
            // Update UI
            currentVersionId = versionId;
            currentVersionName = versionData.version_name || versionData.name;
            updateToolbarDisplay();
            
            // Refresh display
            if (window.updateTable) {
                window.updateTable();
            }
            
            // Close modal
            document.querySelector('.version-modal-overlay')?.remove();
            
            alert(`✅ Loaded version: ${currentVersionName}`);
            
        } catch (err) {
            console.error('📋 Failed to load version:', err);
            alert('❌ Failed to load version: ' + err.message);
        }
    }
    
    async function baseOnVersion(sourceId, sourceName) {
        const newName = prompt(`Create new version based on "${sourceName}":`, `${sourceName} (copy)`);
        if (!newName) return;
        
        console.log("📋 Creating version based on:", sourceId);
        
        try {
            if (window.ScheduleVersionsDB) {
                const result = await window.ScheduleVersionsDB.createBasedOn(sourceId, newName);
                if (result) {
                    currentVersionId = result.id;
                    currentVersionName = newName;
                    updateToolbarDisplay();
                    
                    // Load the new version's data
                    await useVersion(result.id);
                    
                    alert(`✅ Created new version "${newName}" based on "${sourceName}"`);
                }
            } else {
                // Fallback: copy locally
                const stored = JSON.parse(localStorage.getItem('schedule_versions') || '{}');
                let sourceVersion;
                for (const key in stored) {
                    const found = stored[key].find(v => v.id === sourceId);
                    if (found) {
                        sourceVersion = found;
                        break;
                    }
                }
                
                if (sourceVersion) {
                    const campId = getCampId();
                    const date = getCurrentDate();
                    const key = `${campId}_${date}`;
                    
                    if (!stored[key]) stored[key] = [];
                    
                    const newVersion = {
                        id: Date.now().toString(),
                        name: newName,
                        date,
                        campId,
                        data: JSON.parse(JSON.stringify(sourceVersion.data)),
                        basedOn: sourceId,
                        basedOnName: sourceName,
                        createdAt: new Date().toISOString()
                    };
                    
                    stored[key].push(newVersion);
                    localStorage.setItem('schedule_versions', JSON.stringify(stored));
                    
                    await useVersion(newVersion.id);
                }
            }
        } catch (err) {
            console.error('📋 Base on failed:', err);
            alert('❌ Failed to create based-on version: ' + err.message);
        }
        
        document.querySelector('.version-modal-overlay')?.remove();
    }
    
    async function deleteVersion(versionId) {
        if (!confirm('Are you sure you want to delete this version?')) return;
        
        try {
            if (window.ScheduleVersionsDB) {
                await window.ScheduleVersionsDB.deleteVersion(versionId);
            } else {
                const stored = JSON.parse(localStorage.getItem('schedule_versions') || '{}');
                for (const key in stored) {
                    stored[key] = stored[key].filter(v => v.id !== versionId);
                }
                localStorage.setItem('schedule_versions', JSON.stringify(stored));
            }
            
            if (currentVersionId === versionId) {
                currentVersionId = null;
                currentVersionName = 'Unsaved Draft';
                updateToolbarDisplay();
            }
            
            // Refresh modal
            document.querySelector('.version-modal-overlay')?.remove();
            showVersionsModal();
            
        } catch (err) {
            console.error('📋 Delete failed:', err);
            alert('❌ Failed to delete version: ' + err.message);
        }
    }
    
    function updateToolbarDisplay() {
        const nameEl = document.getElementById('current-version-name');
        if (nameEl) {
            nameEl.textContent = currentVersionName;
        }
    }
    
    // =============================================
    // INITIALIZATION
    // =============================================
    
    function init() {
        initAttempts++;
        
        // Check if already initialized
        if (toolbar && document.contains(toolbar)) {
            console.log("📋 Toolbar already exists");
            return;
        }
        
        // Wait for DOM to be more ready
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => setTimeout(init, 100));
            return;
        }
        
        // Try to create toolbar
        const created = createToolbar();
        
        if (!created && initAttempts < MAX_INIT_ATTEMPTS) {
            // Retry with increasing delay
            setTimeout(init, Math.min(500, 100 * initAttempts));
            return;
        }
        
        if (!created) {
            console.log("📋 Creating floating toolbar as fallback");
            createToolbar(); // Will use floating mode
        }
    }
    
    // Export API
    window.ScheduleVersionUI = {
        saveAsNewVersion,
        showVersionsModal,
        useVersion,
        baseOnVersion,
        deleteVersion,
        init,
        
        // For debugging
        getCurrentDate,
        getCampId,
        getCurrentScheduleData
    };
    
    // Auto-initialize
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(init, 500));
    } else {
        setTimeout(init, 500);
    }
    
    // Also try on cloud-hydration-complete
    document.addEventListener('cloud-hydration-complete', () => {
        console.log("📋 Cloud hydration complete, initializing...");
        setTimeout(init, 200);
    });
    
    // Retry periodically until success
    const retryInterval = setInterval(() => {
        if (toolbar && document.contains(toolbar)) {
            clearInterval(retryInterval);
            return;
        }
        if (initAttempts < MAX_INIT_ATTEMPTS) {
            init();
        } else {
            clearInterval(retryInterval);
        }
    }, 1000);
    
    console.log("📋 Schedule Version UI v4.0 loaded");
    
})();
