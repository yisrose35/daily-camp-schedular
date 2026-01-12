// =================================================================
// schedule_version_ui.js — UI for Schedule Versioning
// VERSION: v1.0
// =================================================================
//
// Provides UI components for:
// - Viewing schedule versions
// - Creating new versions ("Base On" feature)
// - Switching between versions
// - Comparing versions
//
// =================================================================
(function() {
    'use strict';

    console.log("📋 Schedule Version UI v1.0 loading...");

    // =========================================================================
    // MODAL TEMPLATE
    // =========================================================================

    function createVersionModal() {
        const modal = document.createElement('div');
        modal.id = 'version-modal';
        modal.innerHTML = `
            <div class="version-modal-overlay" onclick="window.ScheduleVersionUI.closeModal()">
                <div class="version-modal-content" onclick="event.stopPropagation()">
                    <div class="version-modal-header">
                        <h2>📋 Schedule Versions</h2>
                        <button class="version-modal-close" onclick="window.ScheduleVersionUI.closeModal()">×</button>
                    </div>
                    <div class="version-modal-body">
                        <div id="version-list"></div>
                        <div class="version-actions">
                            <button class="btn-create-version" onclick="window.ScheduleVersionUI.showCreateDialog()">
                                + Create New Version
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        const style = document.createElement('style');
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
            }
            .version-modal-content {
                background: white;
                border-radius: 12px;
                width: 90%;
                max-width: 600px;
                max-height: 80vh;
                overflow: hidden;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            }
            .version-modal-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 16px 24px;
                border-bottom: 1px solid #e5e7eb;
                background: #f9fafb;
            }
            .version-modal-header h2 {
                margin: 0;
                font-size: 18px;
            }
            .version-modal-close {
                background: none;
                border: none;
                font-size: 24px;
                cursor: pointer;
                color: #6b7280;
            }
            .version-modal-body {
                padding: 24px;
                overflow-y: auto;
                max-height: 60vh;
            }
            .version-item {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 12px 16px;
                border: 1px solid #e5e7eb;
                border-radius: 8px;
                margin-bottom: 8px;
                transition: all 0.2s;
            }
            .version-item:hover {
                border-color: #3b82f6;
                background: #f0f9ff;
            }
            .version-item.active {
                border-color: #10b981;
                background: #ecfdf5;
            }
            .version-info h4 {
                margin: 0 0 4px 0;
                font-size: 14px;
            }
            .version-meta {
                font-size: 12px;
                color: #6b7280;
            }
            .version-buttons button {
                padding: 6px 12px;
                margin-left: 8px;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
            }
            .btn-activate {
                background: #3b82f6;
                color: white;
            }
            .btn-copy {
                background: #8b5cf6;
                color: white;
            }
            .btn-delete {
                background: #ef4444;
                color: white;
            }
            .btn-create-version {
                width: 100%;
                padding: 12px;
                background: #10b981;
                color: white;
                border: none;
                border-radius: 8px;
                font-size: 14px;
                cursor: pointer;
                margin-top: 16px;
            }
            .btn-create-version:hover {
                background: #059669;
            }
            .version-locked {
                background: #fef3c7;
                border-color: #f59e0b;
            }
            .lock-badge {
                background: #f59e0b;
                color: white;
                padding: 2px 6px;
                border-radius: 4px;
                font-size: 10px;
                margin-left: 8px;
            }
            
            /* Create Dialog */
            .create-version-dialog {
                margin-top: 16px;
                padding: 16px;
                background: #f9fafb;
                border-radius: 8px;
                border: 1px solid #e5e7eb;
            }
            .create-version-dialog label {
                display: block;
                margin-bottom: 4px;
                font-size: 12px;
                font-weight: 600;
                color: #374151;
            }
            .create-version-dialog input,
            .create-version-dialog select {
                width: 100%;
                padding: 8px 12px;
                border: 1px solid #d1d5db;
                border-radius: 6px;
                margin-bottom: 12px;
                font-size: 14px;
            }
            .create-version-dialog .dialog-buttons {
                display: flex;
                gap: 8px;
                justify-content: flex-end;
            }
            .create-version-dialog .dialog-buttons button {
                padding: 8px 16px;
                border: none;
                border-radius: 6px;
                cursor: pointer;
            }
            .btn-cancel {
                background: #e5e7eb;
                color: #374151;
            }
            .btn-confirm {
                background: #10b981;
                color: white;
            }
        `;
        
        document.head.appendChild(style);
        document.body.appendChild(modal);
        modal.style.display = 'none';
        
        return modal;
    }

    // =========================================================================
    // UI FUNCTIONS
    // =========================================================================

    let _modal = null;
    let _currentDate = null;

    function openModal(dateKey) {
        if (!_modal) {
            _modal = createVersionModal();
        }
        
        _currentDate = dateKey || window.currentScheduleDate || new Date().toISOString().split('T')[0];
        
        renderVersionList();
        _modal.style.display = 'block';
    }

    function closeModal() {
        if (_modal) {
            _modal.style.display = 'none';
        }
    }

    function renderVersionList() {
        const listEl = document.getElementById('version-list');
        if (!listEl) return;
        
        // Ensure versioning is available
        if (!window.ScheduleVersioning) {
            listEl.innerHTML = '<p>Versioning system not loaded</p>';
            return;
        }
        
        // Ensure default version exists
        window.ScheduleVersioning.ensureDefaultVersion(_currentDate);
        
        const versions = window.ScheduleVersioning.getVersionsForDate(_currentDate);
        const activeVersion = window.ScheduleVersioning.getActiveVersion(_currentDate);
        
        if (versions.length === 0) {
            listEl.innerHTML = '<p style="color: #6b7280; text-align: center;">No versions yet for this date</p>';
            return;
        }
        
        listEl.innerHTML = versions.map(v => {
            const isActive = v.id === activeVersion;
            const isLocked = v.is_locked;
            const basedOnText = v.based_on ? ` (based on ${v.based_on})` : '';
            
            return `
                <div class="version-item ${isActive ? 'active' : ''} ${isLocked ? 'version-locked' : ''}">
                    <div class="version-info">
                        <h4>
                            ${v.name}
                            ${isActive ? '<span style="color: #10b981;">✓ Active</span>' : ''}
                            ${isLocked ? '<span class="lock-badge">🔒 Locked</span>' : ''}
                        </h4>
                        <div class="version-meta">
                            Created: ${new Date(v.created_at).toLocaleString()}${basedOnText}
                        </div>
                    </div>
                    <div class="version-buttons">
                        ${!isActive ? `<button class="btn-activate" onclick="window.ScheduleVersionUI.activateVersion('${v.id}')">Use</button>` : ''}
                        <button class="btn-copy" onclick="window.ScheduleVersionUI.copyVersion('${v.id}')">Copy</button>
                        ${!isActive && !isLocked ? `<button class="btn-delete" onclick="window.ScheduleVersionUI.deleteVersion('${v.id}')">Delete</button>` : ''}
                    </div>
                </div>
            `;
        }).join('');
    }

    function showCreateDialog() {
        const existing = document.querySelector('.create-version-dialog');
        if (existing) {
            existing.remove();
            return;
        }
        
        const versions = window.ScheduleVersioning?.getVersionsForDate(_currentDate) || [];
        const versionOptions = versions.map(v => `<option value="${v.id}">${v.name}</option>`).join('');
        
        const dialog = document.createElement('div');
        dialog.className = 'create-version-dialog';
        dialog.innerHTML = `
            <label>Version Name</label>
            <input type="text" id="new-version-name" placeholder="e.g., Morning Revision, Rainy Day Plan">
            
            <label>Base On (Optional)</label>
            <select id="base-on-version">
                <option value="">Start from scratch</option>
                ${versionOptions}
            </select>
            
            <div class="dialog-buttons">
                <button class="btn-cancel" onclick="this.closest('.create-version-dialog').remove()">Cancel</button>
                <button class="btn-confirm" onclick="window.ScheduleVersionUI.createNewVersion()">Create</button>
            </div>
        `;
        
        document.getElementById('version-list').after(dialog);
    }

    function createNewVersion() {
        const nameInput = document.getElementById('new-version-name');
        const baseSelect = document.getElementById('base-on-version');
        
        const name = nameInput.value.trim() || `Version ${Date.now()}`;
        const basedOn = baseSelect.value || null;
        
        if (!window.ScheduleVersioning) {
            alert('Versioning system not loaded');
            return;
        }
        
        const result = window.ScheduleVersioning.createVersion(_currentDate, name, basedOn);
        
        if (result.success) {
            // Remove dialog
            document.querySelector('.create-version-dialog')?.remove();
            
            // Refresh list
            renderVersionList();
            
            // Show success
            if (window.showToast) {
                window.showToast(`✅ Created "${name}"`, 'success');
            }
        } else {
            alert('Failed to create version: ' + result.error);
        }
    }

    function activateVersion(versionId) {
        if (!window.ScheduleVersioning) return;
        
        window.ScheduleVersioning.setActiveVersion(_currentDate, versionId);
        
        // Load version data into current schedule
        const data = window.ScheduleVersioning.getVersionData(_currentDate, versionId);
        if (data) {
            const dailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
            dailyData[_currentDate] = data;
            localStorage.setItem('campDailyData_v1', JSON.stringify(dailyData));
            
            // Refresh UI
            window.dispatchEvent(new CustomEvent('campistry-daily-data-updated'));
            if (window.initScheduleSystem) window.initScheduleSystem();
            if (window.updateTable) window.updateTable();
        }
        
        renderVersionList();
        
        if (window.showToast) {
            window.showToast(`✅ Switched to version`, 'success');
        }
    }

    function copyVersion(sourceVersionId) {
        // Show prompt for name
        const name = prompt('Name for the copy:', `Copy of version`);
        if (!name) return;
        
        if (!window.ScheduleVersioning) return;
        
        const result = window.ScheduleVersioning.createVersion(_currentDate, name, sourceVersionId);
        
        if (result.success) {
            renderVersionList();
            if (window.showToast) {
                window.showToast(`✅ Created copy "${name}"`, 'success');
            }
        } else {
            alert('Failed to copy: ' + result.error);
        }
    }

    function deleteVersion(versionId) {
        if (!confirm('Are you sure you want to delete this version?')) return;
        
        if (!window.ScheduleVersioning) return;
        
        const result = window.ScheduleVersioning.deleteVersion(_currentDate, versionId);
        
        if (result.success) {
            renderVersionList();
            if (window.showToast) {
                window.showToast(`🗑️ Version deleted`, 'info');
            }
        } else {
            alert('Cannot delete: ' + result.error);
        }
    }

    // =========================================================================
    // "BASE ON" QUICK ACTION - For Creating Tomorrow's Schedule from Today
    // =========================================================================

    function createScheduleForDate(targetDate, sourceDate, name) {
        sourceDate = sourceDate || window.currentScheduleDate || new Date().toISOString().split('T')[0];
        name = name || `Schedule for ${targetDate}`;
        
        if (window.createScheduleBasedOn) {
            return window.createScheduleBasedOn(sourceDate, targetDate, name);
        } else if (window.ScheduleVersioning) {
            // Fallback to direct copy
            const sourceData = window.ScheduleVersioning.getVersionData(sourceDate, 'v1') ||
                              JSON.parse(localStorage.getItem('campDailyData_v1') || '{}')[sourceDate];
            
            if (!sourceData) {
                return { success: false, error: 'No source schedule found' };
            }
            
            const cloned = JSON.parse(JSON.stringify(sourceData));
            const dailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
            dailyData[targetDate] = cloned;
            localStorage.setItem('campDailyData_v1', JSON.stringify(dailyData));
            
            window.ScheduleVersioning.createVersion(targetDate, name, null);
            
            return { success: true };
        }
        
        return { success: false, error: 'No versioning system available' };
    }

    // =========================================================================
    // ADD VERSION BUTTON TO UI
    // =========================================================================

    function addVersionButtonToUI() {
        // Look for existing toolbar/header
        const toolbar = document.querySelector('.schedule-toolbar') ||
                       document.querySelector('.calendar-header') ||
                       document.querySelector('.main-controls');
        
        if (!toolbar) return;
        
        // Check if button already exists
        if (document.getElementById('version-btn')) return;
        
        const btn = document.createElement('button');
        btn.id = 'version-btn';
        btn.innerHTML = '📋 Versions';
        btn.style.cssText = `
            padding: 8px 16px;
            background: #8b5cf6;
            color: white;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            margin-left: 8px;
        `;
        btn.onclick = () => openModal();
        
        toolbar.appendChild(btn);
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    window.ScheduleVersionUI = {
        openModal,
        closeModal,
        showCreateDialog,
        createNewVersion,
        activateVersion,
        copyVersion,
        deleteVersion,
        createScheduleForDate,
        addVersionButtonToUI
    };

    // Auto-add button when DOM is ready
    if (document.readyState === 'complete') {
        setTimeout(addVersionButtonToUI, 1000);
    } else {
        window.addEventListener('load', () => setTimeout(addVersionButtonToUI, 1000));
    }

    console.log("📋 Schedule Version UI v1.0 loaded");

})();
