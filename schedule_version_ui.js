// =================================================================
// schedule_version_ui.js v2.0 — Database-Backed UI
// =================================================================
//
// This UI connects to ScheduleVersionsDB for proper database storage.
// Each version is a SEPARATE ROW in the database.
// "Base On" creates a NEW row, never modifies the source.
//
// =================================================================
(function() {
    'use strict';

    console.log("📋 Schedule Version UI v2.0 (DB-backed) loading...");

    // =========================================================================
    // STATE
    // =========================================================================
    let _modal = null;
    let _currentDate = null;
    let _versions = [];
    let _isLoading = false;

    // =========================================================================
    // STYLES
    // =========================================================================
    
    function injectStyles() {
        if (document.getElementById('version-ui-styles')) return;
        
        const style = document.createElement('style');
        style.id = 'version-ui-styles';
        style.textContent = `
            .version-modal-overlay {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0,0,0,0.5);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 10000;
                backdrop-filter: blur(2px);
            }
            .version-modal-content {
                background: white;
                border-radius: 16px;
                width: 90%;
                max-width: 700px;
                max-height: 85vh;
                overflow: hidden;
                box-shadow: 0 25px 80px rgba(0,0,0,0.3);
                animation: slideIn 0.2s ease-out;
            }
            @keyframes slideIn {
                from { transform: translateY(-20px); opacity: 0; }
                to { transform: translateY(0); opacity: 1; }
            }
            .version-modal-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 20px 24px;
                border-bottom: 1px solid #e5e7eb;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
            }
            .version-modal-header h2 {
                margin: 0;
                font-size: 20px;
                font-weight: 600;
            }
            .version-modal-header .date-badge {
                background: rgba(255,255,255,0.2);
                padding: 4px 12px;
                border-radius: 20px;
                font-size: 14px;
            }
            .version-modal-close {
                background: rgba(255,255,255,0.2);
                border: none;
                font-size: 24px;
                cursor: pointer;
                color: white;
                width: 36px;
                height: 36px;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: background 0.2s;
            }
            .version-modal-close:hover {
                background: rgba(255,255,255,0.3);
            }
            .version-modal-body {
                padding: 24px;
                overflow-y: auto;
                max-height: calc(85vh - 80px);
            }
            
            /* Version List */
            .version-list {
                display: flex;
                flex-direction: column;
                gap: 12px;
            }
            .version-item {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 16px 20px;
                border: 2px solid #e5e7eb;
                border-radius: 12px;
                transition: all 0.2s;
                background: white;
            }
            .version-item:hover {
                border-color: #667eea;
                box-shadow: 0 4px 12px rgba(102, 126, 234, 0.15);
            }
            .version-item.active {
                border-color: #10b981;
                background: linear-gradient(135deg, #ecfdf5 0%, #d1fae5 100%);
            }
            .version-info {
                flex: 1;
            }
            .version-info h4 {
                margin: 0 0 4px 0;
                font-size: 16px;
                font-weight: 600;
                color: #1f2937;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .version-info .active-badge {
                background: #10b981;
                color: white;
                padding: 2px 8px;
                border-radius: 12px;
                font-size: 11px;
                font-weight: 500;
            }
            .version-meta {
                font-size: 13px;
                color: #6b7280;
            }
            .version-meta .based-on {
                color: #8b5cf6;
                font-style: italic;
            }
            .version-buttons {
                display: flex;
                gap: 8px;
            }
            .version-buttons button {
                padding: 8px 14px;
                border: none;
                border-radius: 8px;
                cursor: pointer;
                font-size: 13px;
                font-weight: 500;
                transition: all 0.2s;
            }
            .btn-activate {
                background: #3b82f6;
                color: white;
            }
            .btn-activate:hover {
                background: #2563eb;
            }
            .btn-base-on {
                background: #8b5cf6;
                color: white;
            }
            .btn-base-on:hover {
                background: #7c3aed;
            }
            .btn-delete {
                background: #fee2e2;
                color: #dc2626;
            }
            .btn-delete:hover {
                background: #fecaca;
            }
            
            /* Create Button */
            .btn-create-version {
                width: 100%;
                padding: 16px;
                background: linear-gradient(135deg, #10b981 0%, #059669 100%);
                color: white;
                border: none;
                border-radius: 12px;
                font-size: 16px;
                font-weight: 600;
                cursor: pointer;
                margin-top: 20px;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 8px;
                transition: all 0.2s;
            }
            .btn-create-version:hover {
                transform: translateY(-2px);
                box-shadow: 0 8px 20px rgba(16, 185, 129, 0.3);
            }
            
            /* Create Dialog */
            .create-version-dialog {
                margin-top: 20px;
                padding: 20px;
                background: #f9fafb;
                border-radius: 12px;
                border: 2px solid #e5e7eb;
            }
            .create-version-dialog h3 {
                margin: 0 0 16px 0;
                font-size: 16px;
                color: #374151;
            }
            .create-version-dialog label {
                display: block;
                margin-bottom: 6px;
                font-size: 13px;
                font-weight: 600;
                color: #374151;
            }
            .create-version-dialog input,
            .create-version-dialog select {
                width: 100%;
                padding: 10px 14px;
                border: 2px solid #e5e7eb;
                border-radius: 8px;
                margin-bottom: 16px;
                font-size: 14px;
                transition: border-color 0.2s;
            }
            .create-version-dialog input:focus,
            .create-version-dialog select:focus {
                outline: none;
                border-color: #667eea;
            }
            .dialog-buttons {
                display: flex;
                gap: 12px;
                justify-content: flex-end;
            }
            .dialog-buttons button {
                padding: 10px 20px;
                border: none;
                border-radius: 8px;
                cursor: pointer;
                font-weight: 500;
            }
            .btn-cancel {
                background: #e5e7eb;
                color: #374151;
            }
            .btn-confirm {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
            }
            
            /* Loading State */
            .version-loading {
                text-align: center;
                padding: 40px;
                color: #6b7280;
            }
            .version-loading .spinner {
                width: 40px;
                height: 40px;
                border: 3px solid #e5e7eb;
                border-top-color: #667eea;
                border-radius: 50%;
                animation: spin 1s linear infinite;
                margin: 0 auto 16px;
            }
            @keyframes spin {
                to { transform: rotate(360deg); }
            }
            
            /* Empty State */
            .version-empty {
                text-align: center;
                padding: 40px;
                color: #9ca3af;
            }
            .version-empty .icon {
                font-size: 48px;
                margin-bottom: 16px;
            }
            
            /* Toolbar Button */
            #version-toolbar-btn {
                padding: 10px 18px;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                border: none;
                border-radius: 8px;
                cursor: pointer;
                font-size: 14px;
                font-weight: 500;
                display: flex;
                align-items: center;
                gap: 8px;
                transition: all 0.2s;
            }
            #version-toolbar-btn:hover {
                transform: translateY(-1px);
                box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
            }
        `;
        document.head.appendChild(style);
    }

    // =========================================================================
    // MODAL
    // =========================================================================

    function createModal() {
        injectStyles();
        
        const modal = document.createElement('div');
        modal.id = 'version-modal';
        modal.innerHTML = `
            <div class="version-modal-overlay" onclick="window.ScheduleVersionUI.closeModal()">
                <div class="version-modal-content" onclick="event.stopPropagation()">
                    <div class="version-modal-header">
                        <div>
                            <h2>📋 Schedule Versions</h2>
                            <span class="date-badge" id="version-date-badge"></span>
                        </div>
                        <button class="version-modal-close" onclick="window.ScheduleVersionUI.closeModal()">×</button>
                    </div>
                    <div class="version-modal-body">
                        <div id="version-list-container"></div>
                        <button class="btn-create-version" onclick="window.ScheduleVersionUI.showCreateDialog()">
                            <span>+</span> Create New Version
                        </button>
                        <div id="create-dialog-container"></div>
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        modal.style.display = 'none';
        
        return modal;
    }

    // =========================================================================
    // OPEN/CLOSE
    // =========================================================================

    async function openModal(dateKey) {
        if (!_modal) {
            _modal = createModal();
        }
        
        _currentDate = dateKey || window.currentScheduleDate || new Date().toISOString().split('T')[0];
        
        document.getElementById('version-date-badge').textContent = _currentDate;
        
        _modal.style.display = 'block';
        
        await loadVersions();
    }

    function closeModal() {
        if (_modal) {
            _modal.style.display = 'none';
        }
    }

    // =========================================================================
    // LOAD & RENDER
    // =========================================================================

    async function loadVersions() {
        const container = document.getElementById('version-list-container');
        
        // Show loading
        container.innerHTML = `
            <div class="version-loading">
                <div class="spinner"></div>
                <div>Loading versions...</div>
            </div>
        `;
        
        _isLoading = true;
        
        try {
            // Check if DB module is available
            if (!window.ScheduleVersionsDB) {
                console.warn("📋 ScheduleVersionsDB not loaded, using fallback");
                container.innerHTML = `
                    <div class="version-empty">
                        <div class="icon">⚠️</div>
                        <div>Database versioning not available.</div>
                        <div style="margin-top: 8px; font-size: 12px;">
                            Run the SQL migration script first.
                        </div>
                    </div>
                `;
                return;
            }
            
            _versions = await window.ScheduleVersionsDB.listVersions(_currentDate);
            
            renderVersionList();
            
        } catch (e) {
            console.error("📋 Error loading versions:", e);
            container.innerHTML = `
                <div class="version-empty">
                    <div class="icon">❌</div>
                    <div>Error loading versions</div>
                    <div style="margin-top: 8px; font-size: 12px;">${e.message}</div>
                </div>
            `;
        } finally {
            _isLoading = false;
        }
    }

    function renderVersionList() {
        const container = document.getElementById('version-list-container');
        
        if (_versions.length === 0) {
            container.innerHTML = `
                <div class="version-empty">
                    <div class="icon">📅</div>
                    <div>No saved versions for ${_currentDate}</div>
                    <div style="margin-top: 8px; font-size: 12px;">
                        Create your first version below!
                    </div>
                </div>
            `;
            return;
        }
        
        const html = _versions.map(v => {
            const isActive = v.is_active;
            const createdAt = new Date(v.created_at).toLocaleString();
            const basedOnVersion = v.based_on ? _versions.find(x => x.id === v.based_on) : null;
            const basedOnText = basedOnVersion ? `Based on "${basedOnVersion.name}"` : '';
            const bunkCount = Object.keys(v.schedule_data?.scheduleAssignments || {}).length;
            
            return `
                <div class="version-item ${isActive ? 'active' : ''}" data-id="${v.id}">
                    <div class="version-info">
                        <h4>
                            ${v.name}
                            ${isActive ? '<span class="active-badge">✓ Active</span>' : ''}
                        </h4>
                        <div class="version-meta">
                            ${bunkCount} bunks • Created ${createdAt}
                            ${basedOnText ? `<span class="based-on">• ${basedOnText}</span>` : ''}
                        </div>
                    </div>
                    <div class="version-buttons">
                        ${!isActive ? `
                            <button class="btn-activate" onclick="window.ScheduleVersionUI.activateVersion('${v.id}')">
                                Use This
                            </button>
                        ` : ''}
                        <button class="btn-base-on" onclick="window.ScheduleVersionUI.baseOnVersion('${v.id}', '${v.name.replace(/'/g, "\\'")}')">
                            Base On
                        </button>
                        ${!isActive ? `
                            <button class="btn-delete" onclick="window.ScheduleVersionUI.deleteVersion('${v.id}')">
                                Delete
                            </button>
                        ` : ''}
                    </div>
                </div>
            `;
        }).join('');
        
        container.innerHTML = `<div class="version-list">${html}</div>`;
    }

    // =========================================================================
    // CREATE DIALOG
    // =========================================================================

    function showCreateDialog() {
        const container = document.getElementById('create-dialog-container');
        
        // Toggle off if already showing
        if (container.innerHTML) {
            container.innerHTML = '';
            return;
        }
        
        const versionOptions = _versions.map(v => 
            `<option value="${v.id}">${v.name}</option>`
        ).join('');
        
        container.innerHTML = `
            <div class="create-version-dialog">
                <h3>Create New Version</h3>
                
                <label for="new-version-name">Version Name *</label>
                <input type="text" id="new-version-name" placeholder="e.g., Rainy Day Plan, Version 2">
                
                <label for="base-on-select">Base On (Optional)</label>
                <select id="base-on-select">
                    <option value="">Start from scratch (empty)</option>
                    <option value="current">Current schedule in editor</option>
                    ${versionOptions}
                </select>
                
                <div class="dialog-buttons">
                    <button class="btn-cancel" onclick="window.ScheduleVersionUI.hideCreateDialog()">Cancel</button>
                    <button class="btn-confirm" onclick="window.ScheduleVersionUI.createVersion()">Create Version</button>
                </div>
            </div>
        `;
        
        document.getElementById('new-version-name').focus();
    }

    function hideCreateDialog() {
        document.getElementById('create-dialog-container').innerHTML = '';
    }

    // =========================================================================
    // ACTIONS
    // =========================================================================

    async function createVersion() {
        const nameInput = document.getElementById('new-version-name');
        const baseSelect = document.getElementById('base-on-select');
        
        const name = nameInput.value.trim();
        const baseOn = baseSelect.value;
        
        if (!name) {
            alert('Please enter a version name');
            nameInput.focus();
            return;
        }
        
        if (!window.ScheduleVersionsDB) {
            alert('Database versioning not available');
            return;
        }
        
        // Show loading
        const btn = document.querySelector('.create-version-dialog .btn-confirm');
        const originalText = btn.textContent;
        btn.textContent = 'Creating...';
        btn.disabled = true;
        
        try {
            let result;
            
            if (baseOn && baseOn !== 'current') {
                // Base on existing version
                result = await window.ScheduleVersionsDB.createBasedOn(baseOn, name);
            } else {
                // Get schedule data
                let scheduleData;
                
                if (baseOn === 'current') {
                    // Use current editor data
                    const dailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
                    scheduleData = dailyData[_currentDate] || { scheduleAssignments: {} };
                } else {
                    // Start fresh
                    scheduleData = { scheduleAssignments: {} };
                }
                
                result = await window.ScheduleVersionsDB.createVersion(
                    _currentDate,
                    name,
                    scheduleData,
                    null
                );
            }
            
            if (result.success) {
                hideCreateDialog();
                await loadVersions();
                
                if (window.showToast) {
                    window.showToast(`✅ Created "${name}"`, 'success');
                }
            } else {
                alert('Failed to create version: ' + result.error);
            }
            
        } catch (e) {
            alert('Error: ' + e.message);
        } finally {
            btn.textContent = originalText;
            btn.disabled = false;
        }
    }

    async function baseOnVersion(sourceId, sourceName) {
        const newName = prompt(`Create new version based on "${sourceName}":\n\nEnter name for the new version:`, `${sourceName} - Copy`);
        
        if (!newName) return;
        
        if (!window.ScheduleVersionsDB) {
            alert('Database versioning not available');
            return;
        }
        
        try {
            const result = await window.ScheduleVersionsDB.createBasedOn(sourceId, newName);
            
            if (result.success) {
                await loadVersions();
                
                if (window.showToast) {
                    window.showToast(`✅ Created "${newName}" based on "${sourceName}"`, 'success');
                }
                
                // Log for debugging
                console.log(`📋 ✅ BASE ON COMPLETE`);
                console.log(`📋    Source: "${sourceName}" (${sourceId}) - UNCHANGED`);
                console.log(`📋    New: "${newName}" (${result.version.id}) - CREATED`);
            } else {
                alert('Failed: ' + result.error);
            }
            
        } catch (e) {
            alert('Error: ' + e.message);
        }
    }

    async function activateVersion(versionId) {
        if (!window.ScheduleVersionsDB) {
            alert('Database versioning not available');
            return;
        }
        
        try {
            // Get the version data
            const version = await window.ScheduleVersionsDB.getVersion(versionId);
            
            if (!version) {
                alert('Version not found');
                return;
            }
            
            // Set as active in database
            const result = await window.ScheduleVersionsDB.setActiveVersion(versionId);
            
            if (result.success) {
                // Load the schedule data into the editor
                const dailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
                dailyData[_currentDate] = version.schedule_data;
                localStorage.setItem('campDailyData_v1', JSON.stringify(dailyData));
                
                // Refresh UI
                window.dispatchEvent(new CustomEvent('campistry-daily-data-updated'));
                if (window.initScheduleSystem) window.initScheduleSystem();
                if (window.updateTable) window.updateTable();
                
                // Refresh version list
                await loadVersions();
                
                if (window.showToast) {
                    window.showToast(`✅ Now using "${version.name}"`, 'success');
                }
            } else {
                alert('Failed to activate: ' + result.error);
            }
            
        } catch (e) {
            alert('Error: ' + e.message);
        }
    }

    async function deleteVersion(versionId) {
        const version = _versions.find(v => v.id === versionId);
        if (!version) return;
        
        if (!confirm(`Delete "${version.name}"?\n\nThis cannot be undone.`)) {
            return;
        }
        
        if (!window.ScheduleVersionsDB) {
            alert('Database versioning not available');
            return;
        }
        
        try {
            const result = await window.ScheduleVersionsDB.deleteVersion(versionId, true);
            
            if (result.success) {
                await loadVersions();
                
                if (window.showToast) {
                    window.showToast(`🗑️ Deleted "${version.name}"`, 'info');
                }
            } else {
                alert('Failed to delete: ' + result.error);
            }
            
        } catch (e) {
            alert('Error: ' + e.message);
        }
    }

    // =========================================================================
    // TOOLBAR BUTTON
    // =========================================================================

    function addToolbarButton() {
        // Find toolbar
        const toolbar = document.querySelector('.schedule-toolbar') ||
                       document.querySelector('.calendar-header') ||
                       document.querySelector('.main-controls') ||
                       document.querySelector('#main-toolbar');
        
        if (!toolbar) {
            console.log("📋 No toolbar found, will retry...");
            setTimeout(addToolbarButton, 2000);
            return;
        }
        
        // Check if already added
        if (document.getElementById('version-toolbar-btn')) return;
        
        injectStyles();
        
        const btn = document.createElement('button');
        btn.id = 'version-toolbar-btn';
        btn.innerHTML = '📋 Versions';
        btn.onclick = () => openModal();
        
        toolbar.appendChild(btn);
        console.log("📋 Toolbar button added");
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    window.ScheduleVersionUI = {
        openModal,
        closeModal,
        showCreateDialog,
        hideCreateDialog,
        createVersion,
        baseOnVersion,
        activateVersion,
        deleteVersion,
        loadVersions,
        addToolbarButton
    };

    // Auto-add button
    if (document.readyState === 'complete') {
        setTimeout(addToolbarButton, 1000);
    } else {
        window.addEventListener('load', () => setTimeout(addToolbarButton, 1000));
    }

    console.log("📋 Schedule Version UI v2.0 loaded");

})();
