/**
 * Schedule Version UI v5.0 (FLOATING TOOLBAR - NO CONTAINER DETECTION)
 * 
 * This version creates a floating toolbar immediately on document.body.
 * No container detection needed - it just works.
 * 
 * Features:
 * - Floating toolbar in top-right corner
 * - Save As New Version (INSERT, not UPDATE)
 * - Base On Version (clone existing)
 * - View All Versions modal
 * - Works with ScheduleVersionsDB for database operations
 */

(function() {
    'use strict';
    
    console.log('📋 Schedule Version UI v5.0 (FLOATING) loading...');
    
    // ========================================
    // STYLES
    // ========================================
    const styles = `
        .sv-floating-toolbar {
            position: fixed;
            top: 70px;
            right: 20px;
            z-index: 10000;
            display: flex;
            gap: 8px;
            padding: 10px 15px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 8px;
            box-shadow: 0 4px 15px rgba(0,0,0,0.2);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
        
        .sv-floating-toolbar button {
            padding: 8px 16px;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        
        .sv-btn-save {
            background: #10b981;
            color: white;
        }
        
        .sv-btn-save:hover {
            background: #059669;
            transform: translateY(-1px);
        }
        
        .sv-btn-versions {
            background: white;
            color: #667eea;
        }
        
        .sv-btn-versions:hover {
            background: #f3f4f6;
            transform: translateY(-1px);
        }
        
        .sv-modal-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.5);
            z-index: 10001;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .sv-modal {
            background: white;
            border-radius: 12px;
            width: 90%;
            max-width: 600px;
            max-height: 80vh;
            overflow: hidden;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        }
        
        .sv-modal-header {
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .sv-modal-header h2 {
            margin: 0;
            font-size: 18px;
            font-weight: 600;
        }
        
        .sv-modal-close {
            background: rgba(255,255,255,0.2);
            border: none;
            color: white;
            width: 32px;
            height: 32px;
            border-radius: 50%;
            cursor: pointer;
            font-size: 18px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .sv-modal-close:hover {
            background: rgba(255,255,255,0.3);
        }
        
        .sv-modal-body {
            padding: 20px;
            max-height: 60vh;
            overflow-y: auto;
        }
        
        .sv-version-list {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        
        .sv-version-item {
            padding: 15px;
            background: #f8fafc;
            border-radius: 8px;
            border: 1px solid #e2e8f0;
        }
        
        .sv-version-item:hover {
            border-color: #667eea;
            background: #f0f4ff;
        }
        
        .sv-version-name {
            font-weight: 600;
            color: #1e293b;
            margin-bottom: 4px;
        }
        
        .sv-version-meta {
            font-size: 12px;
            color: #64748b;
            margin-bottom: 10px;
        }
        
        .sv-version-actions {
            display: flex;
            gap: 8px;
        }
        
        .sv-version-actions button {
            padding: 6px 12px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
        }
        
        .sv-action-use {
            background: #10b981;
            color: white;
        }
        
        .sv-action-use:hover {
            background: #059669;
        }
        
        .sv-action-base {
            background: #3b82f6;
            color: white;
        }
        
        .sv-action-base:hover {
            background: #2563eb;
        }
        
        .sv-action-delete {
            background: #ef4444;
            color: white;
        }
        
        .sv-action-delete:hover {
            background: #dc2626;
        }
        
        .sv-empty-state {
            text-align: center;
            padding: 40px;
            color: #64748b;
        }
        
        .sv-empty-state-icon {
            font-size: 48px;
            margin-bottom: 10px;
        }
        
        .sv-input-modal input {
            width: 100%;
            padding: 12px;
            border: 1px solid #e2e8f0;
            border-radius: 6px;
            font-size: 14px;
            margin-bottom: 15px;
        }
        
        .sv-input-modal input:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }
        
        .sv-input-actions {
            display: flex;
            gap: 10px;
            justify-content: flex-end;
        }
        
        .sv-input-actions button {
            padding: 10px 20px;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-weight: 500;
        }
        
        .sv-input-cancel {
            background: #e2e8f0;
            color: #475569;
        }
        
        .sv-input-confirm {
            background: #10b981;
            color: white;
        }
        
        .sv-toast {
            position: fixed;
            bottom: 20px;
            right: 20px;
            padding: 12px 20px;
            background: #1e293b;
            color: white;
            border-radius: 8px;
            z-index: 10002;
            animation: sv-slide-in 0.3s ease;
        }
        
        .sv-toast.success {
            background: #10b981;
        }
        
        .sv-toast.error {
            background: #ef4444;
        }
        
        @keyframes sv-slide-in {
            from {
                transform: translateY(20px);
                opacity: 0;
            }
            to {
                transform: translateY(0);
                opacity: 1;
            }
        }
    `;
    
    // ========================================
    // INJECT STYLES
    // ========================================
    function injectStyles() {
        if (document.getElementById('sv-styles')) return;
        const styleEl = document.createElement('style');
        styleEl.id = 'sv-styles';
        styleEl.textContent = styles;
        document.head.appendChild(styleEl);
    }
    
    // ========================================
    // TOAST NOTIFICATIONS
    // ========================================
    function showToast(message, type = 'info') {
        const existing = document.querySelector('.sv-toast');
        if (existing) existing.remove();
        
        const toast = document.createElement('div');
        toast.className = `sv-toast ${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);
        
        setTimeout(() => toast.remove(), 3000);
    }
    
    // ========================================
    // GET CURRENT SCHEDULE DATA
    // ========================================
    function getCurrentScheduleData() {
        const data = {
            assignments: window.scheduleAssignments || {},
            unifiedTimes: window.unifiedTimes || [],
            skeleton: window.skeleton || [],
            date: window.currentScheduleDate || new Date().toISOString().split('T')[0]
        };
        
        console.log('📋 Captured schedule data:', {
            assignmentCount: Object.keys(data.assignments).length,
            slotCount: data.unifiedTimes.length,
            date: data.date
        });
        
        return data;
    }
    
    // ========================================
    // SAVE AS NEW VERSION
    // ========================================
    async function saveAsNewVersion() {
        // Show name input modal
        const name = await promptForName('Save New Version', 'Enter a name for this schedule version:');
        if (!name) return;
        
        try {
            const scheduleData = getCurrentScheduleData();
            
            // Check if ScheduleVersionsDB is available
            if (typeof ScheduleVersionsDB === 'undefined') {
                console.error('📋 ScheduleVersionsDB not loaded!');
                showToast('Version database not available', 'error');
                return;
            }
            
            const result = await ScheduleVersionsDB.createVersion(
                name,
                scheduleData.date,
                scheduleData
            );
            
            if (result.success) {
                showToast(`✅ Saved "${name}" as new version`, 'success');
                console.log('📋 Version saved:', result);
            } else {
                showToast('Failed to save version: ' + result.error, 'error');
            }
        } catch (err) {
            console.error('📋 Save error:', err);
            showToast('Error saving version', 'error');
        }
    }
    
    // ========================================
    // BASE ON VERSION (Clone)
    // ========================================
    async function baseOnVersion(sourceId, sourceName) {
        const newName = await promptForName(
            'Base On Version',
            `Create new version based on "${sourceName}":`
        );
        if (!newName) return;
        
        try {
            if (typeof ScheduleVersionsDB === 'undefined') {
                showToast('Version database not available', 'error');
                return;
            }
            
            const result = await ScheduleVersionsDB.createBasedOn(sourceId, newName);
            
            if (result.success) {
                showToast(`✅ Created "${newName}" based on "${sourceName}"`, 'success');
                closeModal();
                // Refresh the versions list
                setTimeout(() => showVersionsModal(), 500);
            } else {
                showToast('Failed to create version: ' + result.error, 'error');
            }
        } catch (err) {
            console.error('📋 Base-on error:', err);
            showToast('Error creating version', 'error');
        }
    }
    
    // ========================================
    // USE VERSION (Load into memory)
    // ========================================
    async function useVersion(id, name) {
        try {
            if (typeof ScheduleVersionsDB === 'undefined') {
                showToast('Version database not available', 'error');
                return;
            }
            
            const result = await ScheduleVersionsDB.getVersion(id);
            
            if (result.success && result.version) {
                const data = result.version.schedule_data;
                
                // Load into global state
                if (data.assignments) {
                    window.scheduleAssignments = data.assignments;
                }
                if (data.unifiedTimes) {
                    window.unifiedTimes = data.unifiedTimes;
                }
                if (data.skeleton) {
                    window.skeleton = data.skeleton;
                }
                
                // Trigger UI refresh
                if (typeof window.updateTable === 'function') {
                    window.updateTable();
                }
                
                showToast(`✅ Loaded "${name}"`, 'success');
                closeModal();
            } else {
                showToast('Failed to load version', 'error');
            }
        } catch (err) {
            console.error('📋 Load error:', err);
            showToast('Error loading version', 'error');
        }
    }
    
    // ========================================
    // DELETE VERSION
    // ========================================
    async function deleteVersion(id, name) {
        if (!confirm(`Delete version "${name}"?\n\nThis cannot be undone.`)) {
            return;
        }
        
        try {
            if (typeof ScheduleVersionsDB === 'undefined') {
                showToast('Version database not available', 'error');
                return;
            }
            
            const result = await ScheduleVersionsDB.deleteVersion(id);
            
            if (result.success) {
                showToast(`🗑️ Deleted "${name}"`, 'success');
                // Refresh the list
                setTimeout(() => showVersionsModal(), 300);
            } else {
                showToast('Failed to delete: ' + result.error, 'error');
            }
        } catch (err) {
            console.error('📋 Delete error:', err);
            showToast('Error deleting version', 'error');
        }
    }
    
    // ========================================
    // PROMPT FOR NAME
    // ========================================
    function promptForName(title, message) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'sv-modal-overlay';
            overlay.innerHTML = `
                <div class="sv-modal sv-input-modal">
                    <div class="sv-modal-header">
                        <h2>${title}</h2>
                        <button class="sv-modal-close">×</button>
                    </div>
                    <div class="sv-modal-body">
                        <p style="margin-bottom: 15px; color: #475569;">${message}</p>
                        <input type="text" placeholder="Version name..." autofocus>
                        <div class="sv-input-actions">
                            <button class="sv-input-cancel">Cancel</button>
                            <button class="sv-input-confirm">Save</button>
                        </div>
                    </div>
                </div>
            `;
            
            document.body.appendChild(overlay);
            
            const input = overlay.querySelector('input');
            const closeBtn = overlay.querySelector('.sv-modal-close');
            const cancelBtn = overlay.querySelector('.sv-input-cancel');
            const confirmBtn = overlay.querySelector('.sv-input-confirm');
            
            input.focus();
            
            const close = (value) => {
                overlay.remove();
                resolve(value);
            };
            
            closeBtn.onclick = () => close(null);
            cancelBtn.onclick = () => close(null);
            overlay.onclick = (e) => { if (e.target === overlay) close(null); };
            
            confirmBtn.onclick = () => {
                const value = input.value.trim();
                if (value) close(value);
            };
            
            input.onkeypress = (e) => {
                if (e.key === 'Enter') {
                    const value = input.value.trim();
                    if (value) close(value);
                }
            };
        });
    }
    
    // ========================================
    // CLOSE MODAL
    // ========================================
    function closeModal() {
        const overlay = document.querySelector('.sv-modal-overlay');
        if (overlay) overlay.remove();
    }
    
    // ========================================
    // SHOW VERSIONS MODAL
    // ========================================
    async function showVersionsModal() {
        // Close any existing modal
        closeModal();
        
        const overlay = document.createElement('div');
        overlay.className = 'sv-modal-overlay';
        overlay.innerHTML = `
            <div class="sv-modal">
                <div class="sv-modal-header">
                    <h2>📋 Schedule Versions</h2>
                    <button class="sv-modal-close">×</button>
                </div>
                <div class="sv-modal-body">
                    <div class="sv-version-list">
                        <div class="sv-empty-state">
                            <div class="sv-empty-state-icon">⏳</div>
                            <div>Loading versions...</div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(overlay);
        
        // Set up close handlers
        overlay.querySelector('.sv-modal-close').onclick = closeModal;
        overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
        
        // Load versions
        try {
            if (typeof ScheduleVersionsDB === 'undefined') {
                overlay.querySelector('.sv-version-list').innerHTML = `
                    <div class="sv-empty-state">
                        <div class="sv-empty-state-icon">⚠️</div>
                        <div>Version database not available</div>
                        <div style="font-size: 12px; margin-top: 5px;">Make sure schedule_versions_db.js is loaded</div>
                    </div>
                `;
                return;
            }
            
            const result = await ScheduleVersionsDB.listVersions();
            const listEl = overlay.querySelector('.sv-version-list');
            
            if (!result.success) {
                listEl.innerHTML = `
                    <div class="sv-empty-state">
                        <div class="sv-empty-state-icon">❌</div>
                        <div>Error loading versions</div>
                        <div style="font-size: 12px; margin-top: 5px;">${result.error}</div>
                    </div>
                `;
                return;
            }
            
            const versions = result.versions || [];
            
            if (versions.length === 0) {
                listEl.innerHTML = `
                    <div class="sv-empty-state">
                        <div class="sv-empty-state-icon">📭</div>
                        <div>No saved versions yet</div>
                        <div style="font-size: 12px; margin-top: 5px;">Click "Save Version" to create your first version</div>
                    </div>
                `;
                return;
            }
            
            // Render versions
            listEl.innerHTML = versions.map(v => {
                const date = new Date(v.created_at).toLocaleString();
                const scheduleDate = v.schedule_date || 'Unknown date';
                return `
                    <div class="sv-version-item" data-id="${v.id}">
                        <div class="sv-version-name">${escapeHtml(v.name)}</div>
                        <div class="sv-version-meta">
                            Schedule: ${scheduleDate} • Saved: ${date}
                        </div>
                        <div class="sv-version-actions">
                            <button class="sv-action-use" data-action="use">✓ Use</button>
                            <button class="sv-action-base" data-action="base">📋 Base On</button>
                            <button class="sv-action-delete" data-action="delete">🗑️ Delete</button>
                        </div>
                    </div>
                `;
            }).join('');
            
            // Add click handlers
            listEl.querySelectorAll('.sv-version-item').forEach(item => {
                const id = item.dataset.id;
                const name = item.querySelector('.sv-version-name').textContent;
                
                item.querySelector('[data-action="use"]').onclick = () => useVersion(id, name);
                item.querySelector('[data-action="base"]').onclick = () => baseOnVersion(id, name);
                item.querySelector('[data-action="delete"]').onclick = () => deleteVersion(id, name);
            });
            
        } catch (err) {
            console.error('📋 Error loading versions:', err);
            overlay.querySelector('.sv-version-list').innerHTML = `
                <div class="sv-empty-state">
                    <div class="sv-empty-state-icon">💥</div>
                    <div>Error loading versions</div>
                    <div style="font-size: 12px; margin-top: 5px;">${err.message}</div>
                </div>
            `;
        }
    }
    
    // ========================================
    // ESCAPE HTML
    // ========================================
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    // ========================================
    // CREATE FLOATING TOOLBAR
    // ========================================
    function createToolbar() {
        // Don't create duplicates
        if (document.getElementById('sv-floating-toolbar')) {
            console.log('📋 Toolbar already exists');
            return;
        }
        
        const toolbar = document.createElement('div');
        toolbar.id = 'sv-floating-toolbar';
        toolbar.className = 'sv-floating-toolbar';
        toolbar.innerHTML = `
            <button class="sv-btn-save" id="sv-save-btn">
                💾 Save Version
            </button>
            <button class="sv-btn-versions" id="sv-versions-btn">
                📋 Versions
            </button>
        `;
        
        document.body.appendChild(toolbar);
        
        // Add click handlers
        document.getElementById('sv-save-btn').onclick = saveAsNewVersion;
        document.getElementById('sv-versions-btn').onclick = showVersionsModal;
        
        console.log('📋 ✅ Floating toolbar created!');
    }
    
    // ========================================
    // INITIALIZE
    // ========================================
    function init() {
        injectStyles();
        
        // Create toolbar immediately when DOM is ready
        if (document.body) {
            createToolbar();
        } else {
            // Wait for body to be available
            document.addEventListener('DOMContentLoaded', createToolbar);
        }
    }
    
    // Run immediately
    init();
    
    // Also expose for debugging
    window.ScheduleVersionUI = {
        saveAsNewVersion,
        showVersionsModal,
        createToolbar
    };
    
    console.log('📋 Schedule Version UI v5.0 loaded');
    console.log('📋 Toolbar should appear in top-right corner');
    
})();
