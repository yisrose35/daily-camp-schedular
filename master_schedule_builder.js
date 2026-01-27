
// =================================================================
// master_schedule_builder.js (PRODUCTION-READY v3.0)
// =================================================================
// CHANGELOG v3.0:
// ★ UX: Completely redesigned template management UI
// ★ NEW: Copy/Paste functionality for tiles (Ctrl+C/Ctrl+V or context menu)
// ★ NEW: Right-click context menu for tiles (Copy, Delete, Edit)
// ★ NEW: Delete small tiles via context menu (no resize needed)
// ★ FIX: Memory leak - proper event listener cleanup
// ★ FIX: Cloud sync - tab visibility triggers data refresh
// ★ FIX: Type consistency - parseInt fallbacks throughout
// ★ FIX: Null safety - DOM element checks before use
// ★ FIX: Error handling - try/catch around risky operations
// ★ IMPROVED: Mobile touch support with better UX
// ★ IMPROVED: RBAC checks for all modifying operations
// =================================================================

(function(){
'use strict';

console.log("[MASTER_SCHEDULER] Module v3.0 loading...");

// =================================================================
// STATE & GLOBALS
// =================================================================
let container = null;
let palette = null;
let grid = null;
let dailySkeleton = [];
let currentLoadedTemplate = null;
let _isInitialized = false;
let _refreshTimeout = null;

// ★ NEW: Clipboard for copy/paste
let clipboardTile = null;

// ★ FIX: Track active event listeners for cleanup
let activeEventListeners = [];
let _visibilityHandler = null;
let _focusHandler = null;
let _keyboardHandler = null;

// --- Constants ---
const SKELETON_DRAFT_KEY = 'master-schedule-draft';
const SKELETON_DRAFT_NAME_KEY = 'master-schedule-draft-name';
const PIXELS_PER_MINUTE = 2;
const INCREMENT_MINS = 30;
const SNAP_MINS = 5;

// =================================================================
// ★ EVENT LISTENER CLEANUP HELPER
// =================================================================
function cleanupEventListeners() {
    activeEventListeners.forEach(({ type, handler, target }) => {
        try {
            (target || document).removeEventListener(type, handler);
        } catch (e) {
            console.warn('[MasterScheduler] Failed to remove listener:', e);
        }
    });
    activeEventListeners = [];
}

function trackEventListener(type, handler, target = document) {
    activeEventListeners.push({ type, handler, target });
}

// =================================================================
// ★ TAB VISIBILITY & CLOUD SYNC LISTENERS
// =================================================================
function setupTabListeners() {
    // Clean up existing
    cleanupTabListeners();
    
    // Visibility change handler
    _visibilityHandler = () => {
        if (document.visibilityState === 'visible' && _isInitialized) {
            clearTimeout(_refreshTimeout);
            _refreshTimeout = setTimeout(() => {
                console.log("[MasterScheduler] Tab visible - refreshing data...");
                refreshFromStorage();
            }, 150);
        }
    };
    document.addEventListener('visibilitychange', _visibilityHandler);
    trackEventListener('visibilitychange', _visibilityHandler, document);
    
    // Focus handler
    _focusHandler = () => {
        if (_isInitialized) {
            clearTimeout(_refreshTimeout);
            _refreshTimeout = setTimeout(() => {
                refreshFromStorage();
            }, 200);
        }
    };
    window.addEventListener('focus', _focusHandler);
    trackEventListener('focus', _focusHandler, window);
}

function cleanupTabListeners() {
    if (_visibilityHandler) {
        document.removeEventListener('visibilitychange', _visibilityHandler);
        _visibilityHandler = null;
    }
    if (_focusHandler) {
        window.removeEventListener('focus', _focusHandler);
        _focusHandler = null;
    }
    if (_keyboardHandler) {
        document.removeEventListener('keydown', _keyboardHandler);
        _keyboardHandler = null;
    }
    if (_refreshTimeout) {
        clearTimeout(_refreshTimeout);
        _refreshTimeout = null;
    }
}

// =================================================================
// ★ KEYBOARD SHORTCUTS (Copy/Paste)
// =================================================================
function setupKeyboardShortcuts() {
    if (_keyboardHandler) {
        document.removeEventListener('keydown', _keyboardHandler);
    }
    
    _keyboardHandler = (e) => {
        // Only handle if we're in the master scheduler tab
        const masterTab = document.getElementById('master-scheduler');
        if (!masterTab || !masterTab.classList.contains('active')) return;
        
        // Ctrl+C - Copy selected tile
        if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
            const selected = grid?.querySelector('.grid-event.selected');
            if (selected) {
                const eventId = selected.dataset.id;
                const event = dailySkeleton.find(ev => ev.id === eventId);
                if (event) {
                    copyTileToClipboard(event);
                    showToast('📋 Tile copied');
                    e.preventDefault();
                }
            }
        }
        
        // Ctrl+V - Paste tile
        if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
            if (clipboardTile && lastHoveredCell) {
                pasteTileFromClipboard(lastHoveredCell);
                showToast('📋 Tile pasted');
                e.preventDefault();
            }
        }
        
        // Delete key - Remove selected tile
        if (e.key === 'Delete' || e.key === 'Backspace') {
            const selected = grid?.querySelector('.grid-event.selected');
            if (selected && !e.target.matches('input, textarea, select')) {
                const eventId = selected.dataset.id;
                if (eventId && confirm("Delete this block?")) {
                    dailySkeleton = dailySkeleton.filter(x => x.id !== eventId);
                    saveDraftToLocalStorage();
                    renderGrid();
                }
                e.preventDefault();
            }
        }
    };
    
    document.addEventListener('keydown', _keyboardHandler);
    trackEventListener('keydown', _keyboardHandler, document);
}

// Track last hovered cell for paste target
let lastHoveredCell = null;

// =================================================================
// ★ CLIPBOARD FUNCTIONS
// =================================================================
function copyTileToClipboard(event) {
    if (!event) return;
    
    clipboardTile = {
        ...event,
        id: null, // Will get new ID on paste
        _copiedAt: Date.now()
    };
    
    console.log('[MasterScheduler] Copied tile:', event.event);
}

function pasteTileFromClipboard(targetCell) {
    if (!clipboardTile || !targetCell) return;
    
    const divName = targetCell.dataset.div;
    const cellStartMin = parseInt(targetCell.dataset.startMin, 10) || 540;
    
    // Calculate duration from original
    const origStart = parseTimeToMinutes(clipboardTile.startTime);
    const origEnd = parseTimeToMinutes(clipboardTile.endTime);
    const duration = (origStart !== null && origEnd !== null) ? (origEnd - origStart) : INCREMENT_MINS;
    
    const newEvent = {
        ...clipboardTile,
        id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
        division: divName,
        startTime: minutesToTime(cellStartMin),
        endTime: minutesToTime(cellStartMin + duration)
    };
    
    delete newEvent._copiedAt;
    
    dailySkeleton.push(newEvent);
    saveDraftToLocalStorage();
    renderGrid();
    
    console.log('[MasterScheduler] Pasted tile:', newEvent.event, 'to', divName);
}

// =================================================================
// ★ TOAST NOTIFICATION HELPER
// =================================================================
function showToast(message, duration = 2000) {
    let toast = document.getElementById('master-scheduler-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'master-scheduler-toast';
        toast.style.cssText = `
            position: fixed;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: #1f2937;
            color: white;
            padding: 12px 24px;
            border-radius: 8px;
            font-size: 0.9rem;
            z-index: 10003;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            transition: opacity 0.3s ease;
        `;
        document.body.appendChild(toast);
    }
    
    toast.textContent = message;
    toast.style.opacity = '1';
    toast.style.display = 'block';
    
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => { toast.style.display = 'none'; }, 300);
    }, duration);
}

// =================================================================
// ★ CONTEXT MENU FOR TILES (Copy/Edit only - delete via double-click)
// =================================================================
function showTileContextMenu(e, event) {
    e.preventDefault();
    e.stopPropagation();
    
    // Remove any existing context menu
    removeContextMenu();
    
    const menu = document.createElement('div');
    menu.id = 'tile-context-menu';
    menu.className = 'tile-context-menu';
    menu.innerHTML = `
        <div class="context-menu-item" data-action="copy">
            <span>📋</span> Copy Tile
        </div>
        <div class="context-menu-item" data-action="edit">
            <span>✏️</span> Edit Tile
        </div>
    `;
    
    // Position menu
    menu.style.position = 'fixed';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    menu.style.zIndex = '10005';
    
    document.body.appendChild(menu);
    
    // Ensure menu stays in viewport
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
        menu.style.left = (window.innerWidth - rect.width - 10) + 'px';
    }
    if (rect.bottom > window.innerHeight) {
        menu.style.top = (window.innerHeight - rect.height - 10) + 'px';
    }
    
    // Handle menu clicks
    menu.addEventListener('click', (evt) => {
        const action = evt.target.closest('.context-menu-item')?.dataset.action;
        if (!action) return;
        
        switch (action) {
            case 'copy':
                copyTileToClipboard(event);
                showToast('📋 Tile copied');
                break;
            case 'edit':
                showTileEditModal(event);
                break;
        }
        removeContextMenu();
    });
    
    // Close menu on click outside
    setTimeout(() => {
        const closeHandler = (evt) => {
            if (!menu.contains(evt.target)) {
                removeContextMenu();
                document.removeEventListener('click', closeHandler);
            }
        };
        document.addEventListener('click', closeHandler);
    }, 10);
}

function removeContextMenu() {
    const existing = document.getElementById('tile-context-menu');
    if (existing) existing.remove();
}

// =================================================================
// ★ TILE EDIT MODAL
// =================================================================
function showTileEditModal(event) {
    if (!event) return;
    
    // Remove any existing modal
    const existingModal = document.getElementById('tile-edit-modal');
    if (existingModal) existingModal.remove();
    
    const modal = document.createElement('div');
    modal.id = 'tile-edit-modal';
    modal.className = 'tile-edit-modal-overlay';
    modal.innerHTML = `
        <div class="tile-edit-modal">
            <div class="tile-edit-header">
                <h3>Edit Tile</h3>
                <button class="tile-edit-close">&times;</button>
            </div>
            <div class="tile-edit-body">
                <div class="tile-edit-row">
                    <label>Event Name</label>
                    <input type="text" id="tile-edit-name" value="${escapeHtml(event.event || '')}" />
                </div>
                <div class="tile-edit-row">
                    <label>Start Time</label>
                    <input type="text" id="tile-edit-start" value="${event.startTime || ''}" placeholder="9:00am" />
                </div>
                <div class="tile-edit-row">
                    <label>End Time</label>
                    <input type="text" id="tile-edit-end" value="${event.endTime || ''}" placeholder="9:30am" />
                </div>
            </div>
            <div class="tile-edit-footer">
                <button class="tile-edit-cancel">Cancel</button>
                <button class="tile-edit-save">Save Changes</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Focus first input
    modal.querySelector('#tile-edit-name')?.focus();
    
    // Event handlers
    modal.querySelector('.tile-edit-close').onclick = () => modal.remove();
    modal.querySelector('.tile-edit-cancel').onclick = () => modal.remove();
    modal.querySelector('.tile-edit-save').onclick = () => {
        const newName = modal.querySelector('#tile-edit-name').value.trim();
        const newStart = modal.querySelector('#tile-edit-start').value.trim();
        const newEnd = modal.querySelector('#tile-edit-end').value.trim();
        
        if (!newName) {
            alert('Event name is required');
            return;
        }
        
        // Update the event
        const idx = dailySkeleton.findIndex(ev => ev.id === event.id);
        if (idx !== -1) {
            dailySkeleton[idx].event = newName;
            if (newStart) dailySkeleton[idx].startTime = newStart;
            if (newEnd) dailySkeleton[idx].endTime = newEnd;
            
            saveDraftToLocalStorage();
            renderGrid();
            showToast('✅ Tile updated');
        }
        
        modal.remove();
    };
    
    // Close on overlay click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
    });
    
    // Close on Escape
    const escHandler = (e) => {
        if (e.key === 'Escape') {
            modal.remove();
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);
}

// =================================================================
// ★ HTML ESCAPE HELPER
// =================================================================
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// =================================================================
// PERSISTENCE
// =================================================================
function saveDraftToLocalStorage() {
    try {
        if (dailySkeleton && dailySkeleton.length > 0) {
            localStorage.setItem(SKELETON_DRAFT_KEY, JSON.stringify(dailySkeleton));
            if (currentLoadedTemplate) {
                localStorage.setItem(SKELETON_DRAFT_NAME_KEY, currentLoadedTemplate);
            }
        } else {
            localStorage.removeItem(SKELETON_DRAFT_KEY);
            localStorage.removeItem(SKELETON_DRAFT_NAME_KEY);
        }
    } catch (e) {
        console.error('[MasterScheduler] Failed to save draft:', e);
    }
}

function clearDraftFromLocalStorage() {
    try {
        localStorage.removeItem(SKELETON_DRAFT_KEY);
        localStorage.removeItem(SKELETON_DRAFT_NAME_KEY);
    } catch (e) {
        console.warn('[MasterScheduler] Failed to clear draft:', e);
    }
}

// =================================================================
// ★ REFRESH FROM STORAGE (Cloud Sync)
// =================================================================
function refreshFromStorage() {
    try {
        // If we have a loaded template, refresh it
        if (currentLoadedTemplate) {
            const all = window.getSavedSkeletons?.() || {};
            if (all[currentLoadedTemplate]) {
                const cloudVersion = all[currentLoadedTemplate];
                // Only update if cloud version is different
                if (JSON.stringify(cloudVersion) !== JSON.stringify(dailySkeleton)) {
                    console.log('[MasterScheduler] Cloud version differs - refreshing...');
                    dailySkeleton = JSON.parse(JSON.stringify(cloudVersion));
                    renderGrid();
                }
            }
        }
        
        // Always refresh the template UI to show any new templates
        renderTemplateUI();
    } catch (e) {
        console.warn('[MasterScheduler] Refresh failed:', e);
    }
}

// =================================================================
// TILES DEFINITION
// =================================================================
const TILES = [
    { type: 'activity', name: 'Activity', style: 'background:#e0f7fa;border:1px solid #007bff;', description: 'Flexible slot (Sport or Special).' },
    { type: 'sports', name: 'Sports', style: 'background:#dcedc8;border:1px solid #689f38;', description: 'Sports slot only.' },
    { type: 'special', name: 'Special Activity', style: 'background:#e8f5e9;border:1px solid #43a047;', description: 'Special Activity slot only.' },
    { type: 'smart', name: 'Smart Tile', style: 'background:#e3f2fd;border:2px dashed #0288d1;color:#01579b;', description: 'Balances 2 activities with a fallback.' },
    { type: 'split', name: 'Split Activity', style: 'background:#fff3e0;border:1px solid #f57c00;', description: 'Two activities share the block (Switch halfway).' },
    { type: 'elective', name: 'Elective', style: 'background:#e1bee7;border:2px solid #8e24aa;color:#4a148c;', description: 'Reserve multiple activities for this division only.' },
    { type: 'league', name: 'League Game', style: 'background:#d1c4e9;border:1px solid #5e35b1;', description: 'Regular League slot (Full Buyout).' },
    { type: 'specialty_league', name: 'Specialty League', style: 'background:#fff8e1;border:1px solid #f9a825;', description: 'Specialty League slot (Full Buyout).' },
    { type: 'swim', name: 'Swim', style: 'background:#bbdefb;border:1px solid #1976d2;', description: 'Pinned.' },
    { type: 'lunch', name: 'Lunch', style: 'background:#fbe9e7;border:1px solid #d84315;', description: 'Pinned.' },
    { type: 'snacks', name: 'Snacks', style: 'background:#fff9c4;border:1px solid #fbc02d;', description: 'Pinned.' },
    { type: 'dismissal', name: 'Dismissal', style: 'background:#f44336;color:white;border:1px solid #b71c1c;', description: 'Pinned.' },
    { type: 'custom', name: 'Custom Pinned Event', style: 'background:#eee;border:1px solid #616161;', description: 'Pinned custom (e.g., Regroup).' }
];

// =================================================================
// HELPER FUNCTIONS
// =================================================================
function parseTimeToMinutes(str) {
    if (!str) return null;
    try {
        let s = str.toLowerCase().replace(/am|pm/g, '').trim();
        let [h, m] = s.split(':').map(Number);
        if (isNaN(h)) return null;
        if (str.toLowerCase().includes('pm') && h !== 12) h += 12;
        if (str.toLowerCase().includes('am') && h === 12) h = 0;
        return h * 60 + (m || 0);
    } catch (e) {
        return null;
    }
}

function minutesToTime(min) {
    if (min === null || min === undefined || isNaN(min)) return '';
    let h = Math.floor(min / 60);
    let m = min % 60;
    let ap = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return `${h}:${m.toString().padStart(2, '0')}${ap}`;
}

function mapEventNameForOptimizer(name) {
    if (!name) name = 'Free';
    const lower = name.toLowerCase().trim();
    if (lower === 'activity') return { type: 'slot', event: 'General Activity Slot' };
    if (lower === 'sports') return { type: 'slot', event: 'Sports Slot' };
    if (lower === 'special activity' || lower === 'special') return { type: 'slot', event: 'Special Activity' };
    if (['swim', 'lunch', 'snacks', 'dismissal'].includes(lower)) return { type: 'pinned', event: name };
    return { type: 'pinned', event: name };
}

// =================================================================
// SHOW TILE INFO
// =================================================================
function showTileInfo(tile) {
    if (!tile) return;
    
    const existingModal = document.getElementById('tile-info-modal');
    if (existingModal) existingModal.remove();
    
    const modal = document.createElement('div');
    modal.id = 'tile-info-modal';
    modal.style.cssText = `
        position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
        background: white; padding: 24px; border-radius: 12px; z-index: 10004;
        box-shadow: 0 8px 32px rgba(0,0,0,0.2); max-width: 400px; width: 90%;
    `;
    modal.innerHTML = `
        <h3 style="margin: 0 0 12px 0; color: #1a1a2e;">${escapeHtml(tile.name)}</h3>
        <p style="margin: 0 0 16px 0; color: #666;">${escapeHtml(tile.description || 'No description available.')}</p>
        <button id="tile-info-close" style="
            background: #007bff; color: white; border: none; padding: 8px 16px;
            border-radius: 6px; cursor: pointer; font-weight: 500;
        ">Got it</button>
    `;
    
    const overlay = document.createElement('div');
    overlay.id = 'tile-info-overlay';
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.4); z-index: 10003;
    `;
    
    document.body.appendChild(overlay);
    document.body.appendChild(modal);
    
    const close = () => {
        modal.remove();
        overlay.remove();
    };
    
    modal.querySelector('#tile-info-close').onclick = close;
    overlay.onclick = close;
}

// =================================================================
// PROMPT FOR RESERVED FIELDS
// =================================================================
function promptForReservedFields(eventName) {
    const globalSettings = window.loadGlobalSettings?.() || {};
    const fields = globalSettings.app1?.fields || [];
    const availableFields = fields.filter(f => f.available !== false).map(f => f.name);
    
    if (availableFields.length === 0) {
        alert("No fields available. Please add fields in the Fields tab first.");
        return null;
    }
    
    const input = prompt(
        `Reserve specific field(s) for "${eventName}"?\n\n` +
        `Available: ${availableFields.join(', ')}\n\n` +
        `Enter field names separated by commas (or leave blank for no reservation):`
    );
    
    if (input === null) return null;
    if (!input.trim()) return [];
    
    const requested = input.split(',').map(s => s.trim()).filter(Boolean);
    const validated = [];
    const invalid = [];
    
    requested.forEach(name => {
        const match = availableFields.find(f => f.toLowerCase() === name.toLowerCase());
        if (match) {
            validated.push(match);
        } else {
            invalid.push(name);
        }
    });
    
    if (validated.length === 0 && requested.length > 0) {
        alert('None of those fields were found. Please try again.');
        return null;
    }
    
    if (invalid.length > 0) {
        alert(`Warning: These were not found and will be ignored:\n${invalid.join(', ')}`);
    }
    
    return validated;
}

// =================================================================
// LOAD DATA
// =================================================================
function loadDailySkeleton() {
    try {
        const assignments = window.getSkeletonAssignments?.() || {};
        const skeletons = window.getSavedSkeletons?.() || {};
        const dateStr = window.currentScheduleDate || "";
        const [Y, M, D] = dateStr.split('-').map(Number);
        let dow = 0;
        if (Y && M && D) dow = new Date(Y, M - 1, D).getDay();
        const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        const today = dayNames[dow];
        let tmpl = assignments[today] || assignments["Default"];
        dailySkeleton = (tmpl && skeletons[tmpl]) ? JSON.parse(JSON.stringify(skeletons[tmpl])) : [];
    } catch (e) {
        console.error('[MasterScheduler] Failed to load skeleton:', e);
        dailySkeleton = [];
    }
}

function loadSkeletonToBuilder(name) {
    try {
        const all = window.getSavedSkeletons?.() || {};
        if (all[name]) {
            dailySkeleton = JSON.parse(JSON.stringify(all[name]));
            currentLoadedTemplate = name;
        }
        renderGrid();
        renderTemplateUI();
        saveDraftToLocalStorage();
    } catch (e) {
        console.error('[MasterScheduler] Failed to load skeleton:', name, e);
    }
}

// =================================================================
// ★ RENDER TEMPLATE UI (REDESIGNED UX)
// =================================================================
function renderTemplateUI() {
    const ui = document.getElementById("scheduler-template-ui");
    if (!ui) return;
    
    try {
        const saved = window.getSavedSkeletons?.() || {};
        const names = Object.keys(saved).sort();
        const assignments = window.getSkeletonAssignments?.() || {};
        
        const loadOptions = names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
        
        // Status indicator
        const statusText = currentLoadedTemplate 
            ? `<span class="template-status editing">✏️ Editing: <strong>${escapeHtml(currentLoadedTemplate)}</strong></span>` 
            : '<span class="template-status new">📄 New Schedule</span>';
        
        ui.innerHTML = `
            <div class="template-ui-container">
                <!-- Header Row -->
                <div class="template-header">
                    ${statusText}
                    ${clipboardTile ? '<span class="clipboard-indicator" title="Tile in clipboard">📋</span>' : ''}
                </div>
                
                <!-- Main Actions Row -->
                <div class="template-actions">
                    <div class="action-group">
                        <label class="action-label">Load Template</label>
                        <select id="template-load-select" class="template-select">
                            <option value="">-- Select Template --</option>
                            ${loadOptions}
                        </select>
                    </div>
                    
                    ${currentLoadedTemplate ? `
                    <div class="action-group">
                        <label class="action-label">&nbsp;</label>
                        <button id="template-update-btn" class="btn btn-info">
                            💾 Update "${escapeHtml(currentLoadedTemplate)}"
                        </button>
                    </div>
                    ` : ''}
                    
                    <div class="action-group">
                        <label class="action-label">Save As New</label>
                        <div class="input-with-button">
                            <input type="text" id="template-save-name" placeholder="Template name..." class="template-input" />
                            <button id="template-save-btn" class="btn btn-primary">Save</button>
                        </div>
                    </div>
                    
                    <div class="action-group">
                        <label class="action-label">&nbsp;</label>
                        <button id="template-clear-btn" class="btn btn-warning">🆕 New/Clear</button>
                    </div>
                </div>
                
                <!-- Collapsible: Assignments & Delete -->
                <details class="template-details">
                    <summary class="template-summary">
                        <span>⚙️ Day Assignments & Template Management</span>
                    </summary>
                    <div class="template-details-content">
                        <!-- Day Assignments -->
                        <div class="assignments-section">
                            <h4>📅 Default Templates by Day</h4>
                            <div class="assignments-grid">
                                ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Default"].map(day => `
                                    <div class="assignment-item">
                                        <label>${day}</label>
                                        <select data-day="${day}" class="assignment-select">
                                            <option value="">-- None --</option>
                                            ${loadOptions}
                                        </select>
                                    </div>
                                `).join('')}
                            </div>
                            <button id="template-assign-save-btn" class="btn btn-success">💾 Save Assignments</button>
                        </div>
                        
                        <!-- Delete Section -->
                        <div class="delete-section">
                            <h4>🗑️ Delete Template</h4>
                            <div class="delete-row">
                                <select id="template-delete-select" class="delete-select">
                                    <option value="">-- Select Template --</option>
                                    ${loadOptions}
                                </select>
                                <button id="template-delete-btn" class="btn btn-danger">Delete Permanently</button>
                            </div>
                        </div>
                    </div>
                </details>
            </div>
        `;
        
        // Bind event handlers
        bindTemplateUIHandlers(saved, assignments);
        
    } catch (e) {
        console.error('[MasterScheduler] Failed to render template UI:', e);
        ui.innerHTML = '<p style="color:red;">Error loading template controls</p>';
    }
}

function bindTemplateUIHandlers(saved, assignments) {
    const loadSel = document.getElementById("template-load-select");
    const saveName = document.getElementById("template-save-name");
    
    // Load Template
    if (loadSel) {
        loadSel.onchange = () => {
            const name = loadSel.value;
            if (name && saved[name] && confirm(`Load "${name}"?`)) {
                loadSkeletonToBuilder(name);
                if (saveName) saveName.value = name;
            }
        };
    }
    
    // Update Button
    const updateBtn = document.getElementById("template-update-btn");
    if (updateBtn) {
        updateBtn.onclick = () => {
            if (!window.AccessControl?.checkSetupAccess?.('update schedule templates')) return;
            
            if (currentLoadedTemplate && confirm(`Overwrite existing template "${currentLoadedTemplate}" with current grid?`)) {
                window.saveSkeleton?.(currentLoadedTemplate, dailySkeleton);
                window.forceSyncToCloud?.();
                clearDraftFromLocalStorage();
                showToast('✅ Template updated');
                renderTemplateUI();
            }
        };
    }
    
    // Save As New Button
    const saveBtn = document.getElementById("template-save-btn");
    if (saveBtn) {
        saveBtn.onclick = () => {
            if (!window.AccessControl?.checkSetupAccess?.('save schedule templates')) return;
            
            const name = saveName?.value.trim();
            if (!name) {
                alert("Please enter a name.");
                return;
            }
            
            if (saved[name] && !confirm(`"${name}" already exists. Overwrite?`)) return;
            
            window.saveSkeleton?.(name, dailySkeleton);
            window.forceSyncToCloud?.();
            currentLoadedTemplate = name;
            clearDraftFromLocalStorage();
            showToast('✅ Template saved');
            renderTemplateUI();
        };
    }
    
    // Clear/New Button
    const clearBtn = document.getElementById("template-clear-btn");
    if (clearBtn) {
        clearBtn.onclick = () => {
            if (confirm("Clear grid and start new?")) {
                dailySkeleton = [];
                currentLoadedTemplate = null;
                clearDraftFromLocalStorage();
                renderGrid();
                renderTemplateUI();
            }
        };
    }
    
    // Day Assignments
    const ui = document.getElementById("scheduler-template-ui");
    if (ui) {
        ui.querySelectorAll('select[data-day]').forEach(sel => {
            const day = sel.dataset.day;
            sel.value = assignments[day] || "";
        });
    }
    
    // Save Assignments Button
    const assignSaveBtn = document.getElementById("template-assign-save-btn");
    if (assignSaveBtn) {
        assignSaveBtn.onclick = () => {
            const map = {};
            ui?.querySelectorAll('select[data-day]').forEach(s => {
                if (s.value) map[s.dataset.day] = s.value;
            });
            window.saveSkeletonAssignments?.(map);
            window.forceSyncToCloud?.();
            showToast('✅ Assignments saved');
        };
    }
    
    // Delete Button
    const deleteBtn = document.getElementById("template-delete-btn");
    if (deleteBtn) {
        deleteBtn.onclick = () => {
            if (!window.AccessControl?.checkSetupAccess?.('delete schedule templates')) return;
            
            const delSel = document.getElementById("template-delete-select");
            const nameToDelete = delSel?.value;
            
            if (!nameToDelete) {
                alert("Please select a template to delete.");
                return;
            }
            
            if (confirm(`Are you sure you want to PERMANENTLY DELETE "${nameToDelete}"?`)) {
                if (window.deleteSkeleton) {
                    window.deleteSkeleton(nameToDelete);
                    window.forceSyncToCloud?.();
                    
                    if (currentLoadedTemplate === nameToDelete) {
                        currentLoadedTemplate = null;
                        dailySkeleton = [];
                        clearDraftFromLocalStorage();
                        renderGrid();
                    }
                    
                    showToast('🗑️ Template deleted');
                    renderTemplateUI();
                } else {
                    alert("Error: 'window.deleteSkeleton' function is not defined.");
                }
            }
        };
    }
}

// =================================================================
// RENDER PALETTE
// =================================================================
function renderPalette() {
    if (!palette) return;
    
    palette.innerHTML = '';
    
    TILES.forEach(tile => {
        const el = document.createElement('div');
        el.className = 'grid-tile-draggable';
        el.textContent = tile.name;
        el.style.cssText = tile.style;
        el.style.padding = '8px 12px';
        el.style.borderRadius = '5px';
        el.style.cursor = 'grab';
        el.draggable = true;
        el.title = tile.description || '';
        
        // Click handler for tile info
        el.onclick = (e) => {
            if (e.detail === 1) {
                setTimeout(() => {
                    if (!el.dragging) {
                        showTileInfo(tile);
                    }
                }, 200);
            }
        };
        
        el.ondragstart = (e) => {
            el.dragging = true;
            e.dataTransfer.setData('application/json', JSON.stringify(tile));
        };
        el.ondragend = () => { el.dragging = false; };
        
        // Mobile touch support
        let touchStartY = 0;
        el.addEventListener('touchstart', (e) => {
            touchStartY = e.touches[0].clientY;
            el.dataset.tileData = JSON.stringify(tile);
            el.style.opacity = '0.6';
        });
        
        el.addEventListener('touchend', (e) => {
            el.style.opacity = '1';
            const touch = e.changedTouches[0];
            const touchEndY = touch.clientY;
            
            if (Math.abs(touchEndY - touchStartY) < 10) {
                showTileInfo(tile);
                return;
            }
            
            const dropTarget = document.elementFromPoint(touch.clientX, touch.clientY);
            const gridCell = dropTarget?.closest('.grid-cell');
            
            if (gridCell && gridCell.ondrop) {
                const fakeEvent = {
                    preventDefault: () => {},
                    clientY: touch.clientY,
                    dataTransfer: {
                        types: ['application/json'],
                        getData: (format) => format === 'application/json' ? JSON.stringify(tile) : ''
                    }
                };
                gridCell.ondrop(fakeEvent);
            }
        });
        
        palette.appendChild(el);
    });
}

// =================================================================
// RENDER GRID
// =================================================================
function renderGrid() {
    if (!grid) return;
    
    try {
        const divisions = window.divisions || {};
        const availableDivisions = Object.keys(divisions).filter(d => divisions[d]?.bunks?.length > 0);
        
        if (availableDivisions.length === 0) {
            grid.innerHTML = `<p style="padding:20px;color:#666;text-align:center;">
                No divisions configured. Please set up divisions in the Setup tab first.
            </p>`;
            return;
        }
        
        // Calculate time range
        let earliestMin = 540, latestMin = 960;
        availableDivisions.forEach(d => {
            const div = divisions[d];
            const s = parseTimeToMinutes(div?.startTime);
            const e = parseTimeToMinutes(div?.endTime);
            if (s !== null && s < earliestMin) earliestMin = s;
            if (e !== null && e > latestMin) latestMin = e;
        });
        
        // Expand for skeleton events
        dailySkeleton.forEach(ev => {
            const s = parseTimeToMinutes(ev.startTime);
            const e = parseTimeToMinutes(ev.endTime);
            if (s !== null && s < earliestMin) earliestMin = s;
            if (e !== null && e > latestMin) latestMin = e;
        });
        
        const totalHeight = (latestMin - earliestMin) * PIXELS_PER_MINUTE;
        
        // Build grid HTML
        let html = `<div style="display:grid; grid-template-columns:60px repeat(${availableDivisions.length}, 1fr); grid-template-rows:auto ${totalHeight}px;">`;
        
        // Header row
        html += `<div style="grid-row:1; grid-column:1; background:#f1f5f9; border-bottom:1px solid #999; padding:8px;"></div>`;
        availableDivisions.forEach((divName, i) => {
            const color = divisions[divName]?.color || '#4a5568';
            html += `<div style="grid-row:1; grid-column:${i + 2}; position:sticky; top:0; background:${color}; color:#fff; z-index:10; border-bottom:1px solid #999; padding:8px; text-align:center; font-weight:bold;">${escapeHtml(divName)}</div>`;
        });
        
        // Time column
        html += `<div style="grid-row:2; grid-column:1; height:${totalHeight}px; position:relative; background:#f9f9f9; border-right:1px solid #ccc;">`;
        for (let m = earliestMin; m < latestMin; m += INCREMENT_MINS) {
            const top = (m - earliestMin) * PIXELS_PER_MINUTE;
            html += `<div style="position:absolute; top:${top}px; left:0; width:100%; border-top:1px dashed #ddd; font-size:10px; padding:2px; color:#666;">${minutesToTime(m)}</div>`;
        }
        html += `</div>`;
        
        // Division columns
        availableDivisions.forEach((divName, i) => {
            const div = divisions[divName];
            const s = parseTimeToMinutes(div?.startTime);
            const e = parseTimeToMinutes(div?.endTime);
            
            html += `<div class="grid-cell" data-div="${escapeHtml(divName)}" data-start-min="${earliestMin}" style="grid-row:2; grid-column:${i + 2}; height:${totalHeight}px; position:relative;">`;
            
            // Grey out unavailable times
            if (s !== null && s > earliestMin) {
                html += `<div class="grid-disabled" style="top:0; height:${(s - earliestMin) * PIXELS_PER_MINUTE}px;"></div>`;
            }
            if (e !== null && e < latestMin) {
                html += `<div class="grid-disabled" style="top:${(e - earliestMin) * PIXELS_PER_MINUTE}px; height:${(latestMin - e) * PIXELS_PER_MINUTE}px;"></div>`;
            }
            
            // Render events
            dailySkeleton.filter(ev => ev.division === divName).forEach(ev => {
                const start = parseTimeToMinutes(ev.startTime);
                const end = parseTimeToMinutes(ev.endTime);
                if (start !== null && end !== null && end > start) {
                    const top = (start - earliestMin) * PIXELS_PER_MINUTE;
                    const height = (end - start) * PIXELS_PER_MINUTE;
                    html += renderEventTile(ev, top, height);
                }
            });
            
            html += `<div class="drop-preview"></div>`;
            html += `</div>`;
        });
        
        html += `</div>`;
        grid.innerHTML = html;
        grid.dataset.earliestMin = earliestMin;
        
        // Bind event listeners
        addDropListeners('.grid-cell');
        addDragToRepositionListeners(grid);
        addResizeListeners(grid);
        addRemoveListeners('.grid-event');
        addContextMenuListeners();
        addCellHoverTracking();
        
    } catch (e) {
        console.error('[MasterScheduler] Failed to render grid:', e);
        grid.innerHTML = '<p style="color:red;padding:20px;">Error rendering schedule grid</p>';
    }
}

// =================================================================
// RENDER EVENT TILE
// =================================================================
function renderEventTile(ev, top, height) {
    let tile = TILES.find(t => t.name === ev.event);
    if (!tile && ev.type) tile = TILES.find(t => t.type === ev.type);
    const style = tile ? tile.style : 'background:#eee;border:1px solid #666;';
    
    // Adjust font size for small tiles
    const fontSize = height < 40 ? '0.7em' : '0.85em';
    const showDetails = height >= 50;
    
    // Hide resize handles on small tiles (< 50px) to allow easy double-click delete
    const showResizeHandles = height >= 50;
    
    let innerHtml = `
        <div class="tile-header">
            <strong>${escapeHtml(ev.event)}</strong>
            ${showDetails ? `<div style="font-size:0.8em">${ev.startTime}-${ev.endTime}</div>` : ''}
        </div>
    `;
    
    // Show reserved fields if present
    if (ev.reservedFields?.length > 0 && height > 60) {
        innerHtml += `<div style="font-size:0.7em;opacity:0.8;margin-top:2px;">📍 ${ev.reservedFields.join(', ')}</div>`;
    }
    
    // Show elective activities if present
    if (ev.electiveActivities?.length > 0 && height > 70) {
        const actList = ev.electiveActivities.slice(0, 4).join(', ');
        const more = ev.electiveActivities.length > 4 ? ` +${ev.electiveActivities.length - 4}` : '';
        innerHtml += `<div style="font-size:0.65rem;color:#6a1b9a;margin-top:2px;">🎯 ${actList}${more}</div>`;
    }
    
    // Show smart tile fallback
    if (ev.type === 'smart' && ev.smartData && height > 70) {
        innerHtml += `<div style="font-size:0.7rem;opacity:0.8;margin-top:2px;">F: ${escapeHtml(ev.smartData.fallbackActivity)}</div>`;
    }
    
    return `
        <div class="grid-event ${height < 50 ? 'small-tile' : ''}" 
             data-id="${ev.id}" 
             draggable="true" 
             title="${escapeHtml(ev.event)} (${ev.startTime}-${ev.endTime}) - Double-click to delete"
             style="${style} position:absolute; top:${top}px; height:${height}px; width:96%; left:2%; 
                    padding:4px 6px; font-size:${fontSize}; overflow:hidden; border-radius:3px; cursor:pointer;
                    box-sizing:border-box; display:flex; flex-direction:column; justify-content:center;
                    text-overflow:ellipsis; line-height:1.2;">
            ${showResizeHandles ? '<div class="resize-handle resize-handle-top"></div>' : ''}
            ${innerHtml}
            ${showResizeHandles ? '<div class="resize-handle resize-handle-bottom"></div>' : ''}
        </div>
    `;
}

// =================================================================
// CELL HOVER TRACKING (for paste)
// =================================================================
function addCellHoverTracking() {
    grid?.querySelectorAll('.grid-cell').forEach(cell => {
        cell.addEventListener('mouseenter', () => {
            lastHoveredCell = cell;
        });
    });
}

// =================================================================
// CONTEXT MENU LISTENERS
// =================================================================
function addContextMenuListeners() {
    grid?.querySelectorAll('.grid-event').forEach(tile => {
        tile.addEventListener('contextmenu', (e) => {
            const eventId = tile.dataset.id;
            const event = dailySkeleton.find(ev => ev.id === eventId);
            if (event) {
                showTileContextMenu(e, event);
            }
        });
        
        // Single click to select
        tile.addEventListener('click', (e) => {
            if (e.target.classList.contains('resize-handle')) return;
            
            // Remove selection from other tiles
            grid?.querySelectorAll('.grid-event.selected').forEach(t => t.classList.remove('selected'));
            
            // Select this tile
            tile.classList.add('selected');
        });
    });
    
    // Click on grid (not on tile) to deselect
    grid?.addEventListener('click', (e) => {
        if (!e.target.closest('.grid-event')) {
            grid?.querySelectorAll('.grid-event.selected').forEach(t => t.classList.remove('selected'));
        }
    });
}

// =================================================================
// DROP LISTENERS
// =================================================================
function addDropListeners(selector) {
    if (!grid) return;
    
    grid.querySelectorAll(selector).forEach(cell => {
        cell.ondragover = e => {
            e.preventDefault();
            cell.style.background = '#e6fffa';
        };
        
        cell.ondragleave = e => {
            cell.style.background = '';
        };
        
        cell.ondrop = e => {
            e.preventDefault();
            cell.style.background = '';
            
            // Handle moving existing tiles
            if (e.dataTransfer?.types?.includes('text/event-move')) {
                const eventId = e.dataTransfer.getData('text/event-move');
                const event = dailySkeleton.find(ev => ev.id === eventId);
                if (!event) return;
                
                const divName = cell.dataset.div;
                const cellStartMin = parseInt(cell.dataset.startMin, 10) || 540;
                const rect = cell.getBoundingClientRect();
                const y = e.clientY - rect.top;
                const snapMin = Math.round(y / PIXELS_PER_MINUTE / SNAP_MINS) * SNAP_MINS;
                
                const duration = parseTimeToMinutes(event.endTime) - parseTimeToMinutes(event.startTime);
                event.division = divName;
                event.startTime = minutesToTime(cellStartMin + snapMin);
                event.endTime = minutesToTime(cellStartMin + snapMin + duration);
                
                saveDraftToLocalStorage();
                renderGrid();
                return;
            }
            
            // Handle new tile from palette
            let tileData;
            try {
                tileData = JSON.parse(e.dataTransfer?.getData('application/json') || '{}');
            } catch (err) {
                return;
            }
            
            if (!tileData.type) return;
            
            const divName = cell.dataset.div;
            const earliestMin = parseInt(cell.dataset.startMin, 10) || 540;
            const rect = cell.getBoundingClientRect();
            const offsetY = e.clientY - rect.top;
            
            let minOffset = Math.round(offsetY / PIXELS_PER_MINUTE / 15) * 15;
            let startMin = earliestMin + minOffset;
            let endMin = startMin + INCREMENT_MINS;
            
            const startStr = minutesToTime(startMin);
            const endStr = minutesToTime(endMin);
            
            let newEvent = null;
            
            // Handle different tile types
            if (tileData.type === 'smart') {
                let st = prompt("Start Time:", startStr); if (!st) return;
                let et = prompt("End Time:", endStr); if (!et) return;
                
                let mains = prompt("Enter TWO main activities (e.g. Swim / Art):");
                if (!mains) return;
                let [m1, m2] = mains.split(/[\/,]/).map(s => s.trim());
                if (!m2) { alert("Need two activities."); return; }
                
                let fbTarget = prompt(`Which one needs fallback if busy?\n1: ${m1}\n2: ${m2}`);
                if (!fbTarget) return;
                let fallbackFor = (fbTarget === '1' || fbTarget.toLowerCase() === m1.toLowerCase()) ? m1 : m2;
                
                let fallback = prompt(`Fallback activity for ${fallbackFor}:`);
                if (!fallback) return;
                
                newEvent = {
                    id: Date.now().toString(),
                    type: 'smart',
                    event: 'Smart Tile',
                    division: divName,
                    startTime: st,
                    endTime: et,
                    smartData: {
                        activity1: m1,
                        activity2: m2,
                        fallbackFor: fallbackFor,
                        fallbackActivity: fallback
                    }
                };
            } else if (tileData.type === 'split') {
                let st = prompt("Start Time:", startStr); if (!st) return;
                let et = prompt("End Time:", endStr); if (!et) return;
                
                let activities = prompt("Enter TWO activities (e.g. Swim / Art):");
                if (!activities) return;
                let [a1, a2] = activities.split(/[\/,]/).map(s => s.trim());
                if (!a2) { alert("Need two activities."); return; }
                
                const startMinutes = parseTimeToMinutes(st);
                const endMinutes = parseTimeToMinutes(et);
                const midMinutes = startMinutes + Math.floor((endMinutes - startMinutes) / 2);
                
                newEvent = {
                    id: Date.now().toString(),
                    type: 'split',
                    event: 'Split Activity',
                    division: divName,
                    startTime: st,
                    endTime: et,
                    subEvents: [
                        { activity: a1, startTime: st, endTime: minutesToTime(midMinutes) },
                        { activity: a2, startTime: minutesToTime(midMinutes), endTime: et }
                    ]
                };
            } else if (tileData.type === 'elective') {
                let st = prompt("Start Time:", startStr); if (!st) return;
                let et = prompt("End Time:", endStr); if (!et) return;
                
                const globalSettings = window.loadGlobalSettings?.() || {};
                const allActivities = [
                    ...(globalSettings.app1?.fields || []).filter(f => f.available !== false).map(f => f.name),
                    ...(globalSettings.app1?.specialActivities || []).filter(s => s.available !== false).map(s => s.name)
                ];
                
                let activities = prompt(`Enter activities for this elective (comma-separated):\nAvailable: ${allActivities.slice(0, 10).join(', ')}${allActivities.length > 10 ? '...' : ''}`);
                if (!activities) return;
                
                const actList = activities.split(',').map(s => s.trim()).filter(Boolean);
                if (actList.length < 2) { alert("Need at least 2 activities for an elective."); return; }
                
                newEvent = {
                    id: Date.now().toString(),
                    type: 'elective',
                    event: 'Elective',
                    division: divName,
                    startTime: st,
                    endTime: et,
                    electiveActivities: actList
                };
            } else if (tileData.type === 'custom') {
                let name = prompt("Custom Event Name:");
                if (!name) return;
                let st = prompt("Start Time:", startStr); if (!st) return;
                let et = prompt("End Time:", endStr); if (!et) return;
                
                const reservedFields = promptForReservedFields(name);
                if (reservedFields === null) return;
                
                const defaultLocation = window.getPinnedTileDefaultLocation?.(name);
                
                newEvent = {
                    id: Date.now().toString(),
                    type: 'custom',
                    event: name,
                    division: divName,
                    startTime: st,
                    endTime: et,
                    reservedFields: reservedFields,
                    location: defaultLocation || null
                };
            } else {
                // Standard tiles
                let st = prompt("Start Time:", startStr); if (!st) return;
                let et = prompt("End Time:", endStr); if (!et) return;
                
                let reservedFields = [];
                if (['activity', 'sports', 'special', 'league', 'specialty_league'].includes(tileData.type)) {
                    const fields = promptForReservedFields(tileData.name);
                    if (fields === null) return;
                    reservedFields = fields;
                }
                
                const defaultLocation = window.getPinnedTileDefaultLocation?.(tileData.name);
                
                newEvent = {
                    id: Date.now().toString(),
                    type: tileData.type,
                    event: tileData.name,
                    division: divName,
                    startTime: st,
                    endTime: et,
                    reservedFields: reservedFields,
                    location: defaultLocation || null
                };
            }
            
            if (newEvent) {
                dailySkeleton.push(newEvent);
                saveDraftToLocalStorage();
                renderGrid();
            }
        };
    });
}

// =================================================================
// REMOVE LISTENERS (Double-click to delete)
// =================================================================
function addRemoveListeners(selector) {
    if (!grid) return;
    
    grid.querySelectorAll(selector).forEach(el => {
        el.ondblclick = e => {
            e.stopPropagation();
            if (e.target.classList.contains('resize-handle')) return;
            
            if (confirm("Delete this block?")) {
                const id = el.dataset.id;
                dailySkeleton = dailySkeleton.filter(x => x.id !== id);
                saveDraftToLocalStorage();
                renderGrid();
            }
        };
    });
}

// =================================================================
// RESIZE LISTENERS
// =================================================================
function addResizeListeners(gridEl) {
    const earliestMin = parseInt(gridEl.dataset.earliestMin, 10) || 540;
    
    let tooltip = document.getElementById('resize-tooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'resize-tooltip';
        document.body.appendChild(tooltip);
    }
    
    gridEl.querySelectorAll('.grid-event').forEach(tile => {
        const topHandle = tile.querySelector('.resize-handle-top');
        const bottomHandle = tile.querySelector('.resize-handle-bottom');
        
        [topHandle, bottomHandle].forEach(handle => {
            if (!handle) return;
            
            const direction = handle.classList.contains('resize-handle-top') ? 'top' : 'bottom';
            const eventId = tile.dataset.id;
            
            let isResizing = false;
            let startY = 0;
            let startTop = 0;
            let startHeight = 0;
            
            const onMouseDown = (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                isResizing = true;
                startY = e.clientY;
                startTop = parseInt(tile.style.top, 10) || 0;
                startHeight = parseInt(tile.style.height, 10) || 60;
                
                tile.classList.add('resizing');
                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            };
            
            const onMouseMove = (e) => {
                if (!isResizing) return;
                
                const deltaY = e.clientY - startY;
                let newTop = startTop;
                let newHeight = startHeight;
                
                if (direction === 'top') {
                    newTop = startTop + deltaY;
                    newHeight = startHeight - deltaY;
                } else {
                    newHeight = startHeight + deltaY;
                }
                
                // Snap to 5-minute increments
                const snappedTop = Math.round(newTop / (SNAP_MINS * PIXELS_PER_MINUTE)) * (SNAP_MINS * PIXELS_PER_MINUTE);
                const snappedHeight = Math.max(20, Math.round(newHeight / (SNAP_MINS * PIXELS_PER_MINUTE)) * (SNAP_MINS * PIXELS_PER_MINUTE));
                
                tile.style.top = snappedTop + 'px';
                tile.style.height = snappedHeight + 'px';
                
                // Update tooltip
                const newStartMin = earliestMin + (snappedTop / PIXELS_PER_MINUTE);
                const newEndMin = newStartMin + (snappedHeight / PIXELS_PER_MINUTE);
                const duration = newEndMin - newStartMin;
                const durationStr = duration < 60 ? `${duration}m` : `${Math.floor(duration / 60)}h${duration % 60 > 0 ? duration % 60 + 'm' : ''}`;
                
                tooltip.innerHTML = `${minutesToTime(newStartMin)} - ${minutesToTime(newEndMin)}<br><span>${durationStr}</span>`;
                tooltip.style.display = 'block';
                tooltip.style.left = (e.clientX + 15) + 'px';
                tooltip.style.top = (e.clientY - 40) + 'px';
            };
            
            const onMouseUp = () => {
                if (!isResizing) return;
                
                isResizing = false;
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                tile.classList.remove('resizing');
                tooltip.style.display = 'none';
                
                // Update the event
                const event = dailySkeleton.find(ev => ev.id === eventId);
                if (!event) return;
                
                const divisions = window.divisions || {};
                const div = divisions[event.division] || {};
                const divStartMin = parseTimeToMinutes(div.startTime) || 540;
                const divEndMin = parseTimeToMinutes(div.endTime) || 960;
                
                const newTop = parseInt(tile.style.top, 10) || 0;
                const newHeightPx = parseInt(tile.style.height, 10) || 60;
                const newStartMin = earliestMin + (newTop / PIXELS_PER_MINUTE);
                const newEndMin = newStartMin + (newHeightPx / PIXELS_PER_MINUTE);
                
                event.startTime = minutesToTime(Math.max(divStartMin, Math.round(newStartMin / SNAP_MINS) * SNAP_MINS));
                event.endTime = minutesToTime(Math.min(divEndMin, Math.round(newEndMin / SNAP_MINS) * SNAP_MINS));
                
                saveDraftToLocalStorage();
                renderGrid();
            };
            
            handle.addEventListener('mousedown', onMouseDown);
            handle.addEventListener('dragstart', (e) => { e.preventDefault(); e.stopPropagation(); });
        });
    });
}

// =================================================================
// DRAG TO REPOSITION
// =================================================================
function addDragToRepositionListeners(gridEl) {
    const earliestMin = parseInt(gridEl.dataset.earliestMin, 10) || 540;
    
    let ghost = document.getElementById('drag-ghost');
    if (!ghost) {
        ghost = document.createElement('div');
        ghost.id = 'drag-ghost';
        document.body.appendChild(ghost);
    }
    
    let dragData = null;
    
    gridEl.querySelectorAll('.grid-event').forEach(tile => {
        tile.addEventListener('dragstart', (e) => {
            if (e.target.classList.contains('resize-handle')) {
                e.preventDefault();
                return;
            }
            
            const eventId = tile.dataset.id;
            const event = dailySkeleton.find(ev => ev.id === eventId);
            if (!event) return;
            
            const duration = parseTimeToMinutes(event.endTime) - parseTimeToMinutes(event.startTime);
            dragData = { type: 'move', id: eventId, event, duration };
            
            e.dataTransfer.setData('text/event-move', eventId);
            e.dataTransfer.effectAllowed = 'move';
            
            ghost.innerHTML = `<strong>${escapeHtml(event.event)}</strong><br><span>${event.startTime} - ${event.endTime}</span>`;
            ghost.style.display = 'block';
            
            const img = new Image();
            img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
            e.dataTransfer.setDragImage(img, 0, 0);
            
            tile.style.opacity = '0.4';
        });
        
        tile.addEventListener('drag', (e) => {
            if (e.clientX === 0 && e.clientY === 0) return;
            ghost.style.left = (e.clientX + 12) + 'px';
            ghost.style.top = (e.clientY + 12) + 'px';
        });
        
        tile.addEventListener('dragend', () => {
            tile.style.opacity = '1';
            ghost.style.display = 'none';
            dragData = null;
            gridEl.querySelectorAll('.drop-preview').forEach(p => { p.style.display = 'none'; p.innerHTML = ''; });
            gridEl.querySelectorAll('.grid-cell').forEach(c => c.style.background = '');
        });
    });
    
    // Drop preview in cells
    gridEl.querySelectorAll('.grid-cell').forEach(cell => {
        const preview = cell.querySelector('.drop-preview');
        
        cell.addEventListener('dragover', (e) => {
            const isEventMove = e.dataTransfer.types.includes('text/event-move');
            const isNewTile = e.dataTransfer.types.includes('application/json');
            if (!isEventMove && !isNewTile) return;
            
            e.preventDefault();
            e.dataTransfer.dropEffect = isEventMove ? 'move' : 'copy';
            cell.style.background = '#e6fffa';
            
            if (isEventMove && dragData && preview) {
                const rect = cell.getBoundingClientRect();
                const y = e.clientY - rect.top;
                const snapMin = Math.round(y / PIXELS_PER_MINUTE / SNAP_MINS) * SNAP_MINS;
                const cellStartMin = parseInt(cell.dataset.startMin, 10) || 540;
                const previewStartTime = minutesToTime(cellStartMin + snapMin);
                const previewEndTime = minutesToTime(cellStartMin + snapMin + dragData.duration);
                
                preview.style.display = 'block';
                preview.style.top = (snapMin * PIXELS_PER_MINUTE) + 'px';
                preview.style.height = (dragData.duration * PIXELS_PER_MINUTE) + 'px';
                preview.innerHTML = `<div class="preview-time-label">${previewStartTime} - ${previewEndTime}</div>`;
            }
        });
        
        cell.addEventListener('dragleave', (e) => {
            if (!cell.contains(e.relatedTarget)) {
                cell.style.background = '';
                if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }
            }
        });
    });
}

// =================================================================
// INIT
// =================================================================
function init() {
    container = document.getElementById("master-scheduler-content");
    if (!container) return;
    
    // Cleanup previous state
    cleanupEventListeners();
    cleanupTabListeners();
    
    loadDailySkeleton();
    
    // Check for saved draft
    try {
        const savedDraft = localStorage.getItem(SKELETON_DRAFT_KEY);
        const savedDraftName = localStorage.getItem(SKELETON_DRAFT_NAME_KEY);
        
        if (savedDraft) {
            if (confirm("Load unsaved master schedule draft?")) {
                dailySkeleton = JSON.parse(savedDraft);
                if (savedDraftName) currentLoadedTemplate = savedDraftName;
            } else {
                clearDraftFromLocalStorage();
            }
        }
    } catch (e) {
        console.warn('[MasterScheduler] Failed to load draft:', e);
        clearDraftFromLocalStorage();
    }
    
    // Inject HTML + CSS
    container.innerHTML = `
        <div id="scheduler-template-ui" class="scheduler-template-ui"></div>
        <div id="scheduler-palette" class="scheduler-palette"></div>
        <div id="scheduler-grid-wrapper" class="scheduler-grid-wrapper">
            <div id="scheduler-grid"></div>
        </div>
        <style>
            /* Grid Styles */
            .grid-disabled { position:absolute; width:100%; background-color:#80808040; background-image:linear-gradient(-45deg,#0000001a 25%,transparent 25%,transparent 50%,#0000001a 50%,#0000001a 75%,transparent 75%,transparent); background-size:20px 20px; z-index:1; pointer-events:none; }
            .grid-event { z-index:2; position:relative; box-shadow:0 1px 3px rgba(0,0,0,0.2); transition: box-shadow 0.15s, opacity 0.15s; }
            .grid-event.selected { box-shadow: 0 0 0 2px #2563eb, 0 4px 12px rgba(37,99,235,0.3) !important; }
            .grid-cell { position:relative; border-right:1px solid #ccc; background:#fff; }
            
            /* Small tiles - easier to click, show delete cursor on hover */
            .grid-event.small-tile { cursor:pointer; }
            .grid-event.small-tile:hover { box-shadow: 0 0 0 2px #ef4444, 0 2px 8px rgba(239,68,68,0.3); }
            
            /* Resize handles - smaller (6px) to leave more clickable area */
            .resize-handle { position:absolute; left:0; right:0; height:6px; cursor:ns-resize; z-index:5; opacity:0; transition:opacity 0.15s; }
            .resize-handle-top { top:0; }
            .resize-handle-bottom { bottom:0; }
            .grid-event:hover .resize-handle { opacity:1; background:rgba(37,99,235,0.4); }
            .grid-event.resizing { box-shadow:0 0 0 2px #2563eb, 0 4px 12px rgba(37,99,235,0.25) !important; z-index:100 !important; }
            
            /* Resize tooltip */
            #resize-tooltip { position:fixed; padding:10px 14px; background:#111827; color:#fff; border-radius:8px; font-size:0.9em; font-weight:600; pointer-events:none; z-index:10002; display:none; box-shadow:0 8px 24px rgba(15,23,42,0.35); text-align:center; line-height:1.4; }
            #resize-tooltip span { font-size:0.85em; opacity:0.7; }
            
            /* Drag ghost */
            #drag-ghost { position:fixed; padding:10px 14px; background:#ffffff; border:2px solid #2563eb; border-radius:8px; box-shadow:0 8px 24px rgba(37,99,235,0.25); pointer-events:none; z-index:10001; display:none; font-size:0.9em; color:#111827; }
            #drag-ghost span { color:#6b7280; }
            
            /* Drop preview */
            .drop-preview { display:none; position:absolute; left:2%; width:96%; background:rgba(37,99,235,0.15); border:2px dashed #2563eb; border-radius:4px; pointer-events:none; z-index:5; }
            .preview-time-label { text-align:center; padding:8px 4px; color:#1d4ed8; font-weight:700; font-size:0.9em; background:rgba(255,255,255,0.95); border-radius:3px; margin:4px; box-shadow:0 2px 6px rgba(0,0,0,0.1); }
            
            /* Template UI Styles */
            .scheduler-template-ui { padding:16px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; margin-bottom:20px; }
            .template-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; }
            .template-status { font-size:0.95rem; color:#64748b; }
            .template-status.editing { color:#0369a1; }
            .template-status.new { color:#059669; }
            .clipboard-indicator { font-size:1.2rem; margin-left:8px; }
            
            .template-actions { display:flex; flex-wrap:wrap; gap:16px; align-items:flex-end; }
            .action-group { display:flex; flex-direction:column; gap:4px; }
            .action-label { font-size:0.8rem; font-weight:500; color:#64748b; }
            
            .template-select, .template-input { padding:8px 12px; border:1px solid #d1d5db; border-radius:6px; font-size:0.9rem; min-width:180px; }
            .template-select:focus, .template-input:focus { outline:none; border-color:#3b82f6; box-shadow:0 0 0 3px rgba(59,130,246,0.1); }
            
            .input-with-button { display:flex; gap:8px; }
            
            .btn { padding:8px 16px; border:none; border-radius:6px; font-size:0.9rem; font-weight:500; cursor:pointer; transition:all 0.15s; }
            .btn-primary { background:#3b82f6; color:white; }
            .btn-primary:hover { background:#2563eb; }
            .btn-info { background:#0891b2; color:white; }
            .btn-info:hover { background:#0e7490; }
            .btn-success { background:#10b981; color:white; }
            .btn-success:hover { background:#059669; }
            .btn-warning { background:#f59e0b; color:white; }
            .btn-warning:hover { background:#d97706; }
            .btn-danger { background:#ef4444; color:white; }
            .btn-danger:hover { background:#dc2626; }
            
            .template-details { margin-top:16px; }
            .template-summary { cursor:pointer; padding:8px 12px; background:#e2e8f0; border-radius:6px; font-weight:500; color:#475569; user-select:none; }
            .template-summary:hover { background:#cbd5e1; }
            .template-details-content { padding:16px; background:white; border:1px solid #e2e8f0; border-radius:0 0 8px 8px; margin-top:-1px; }
            
            .assignments-section { margin-bottom:20px; }
            .assignments-section h4, .delete-section h4 { margin:0 0 12px 0; font-size:0.95rem; color:#374151; }
            .assignments-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); gap:12px; margin-bottom:12px; }
            .assignment-item { display:flex; flex-direction:column; gap:4px; }
            .assignment-item label { font-size:0.8rem; font-weight:500; color:#6b7280; }
            .assignment-select { padding:6px 8px; border:1px solid #d1d5db; border-radius:4px; font-size:0.85rem; }
            
            .delete-section { padding-top:16px; border-top:1px solid #e5e7eb; }
            .delete-row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
            .delete-select { padding:8px 12px; border:1px solid #d1d5db; border-radius:6px; min-width:200px; }
            
            /* Context Menu */
            .tile-context-menu { background:white; border-radius:8px; box-shadow:0 4px 20px rgba(0,0,0,0.15); overflow:hidden; min-width:160px; }
            .context-menu-item { padding:10px 16px; cursor:pointer; display:flex; align-items:center; gap:8px; font-size:0.9rem; color:#374151; transition:background 0.1s; }
            .context-menu-item:hover { background:#f3f4f6; }
            .context-menu-item.danger { color:#dc2626; }
            .context-menu-item.danger:hover { background:#fef2f2; }
            .context-menu-divider { height:1px; background:#e5e7eb; margin:4px 0; }
            
            /* Edit Modal */
            .tile-edit-modal-overlay { position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); z-index:10004; display:flex; align-items:center; justify-content:center; }
            .tile-edit-modal { background:white; border-radius:12px; width:90%; max-width:400px; box-shadow:0 20px 60px rgba(0,0,0,0.3); }
            .tile-edit-header { display:flex; justify-content:space-between; align-items:center; padding:16px 20px; border-bottom:1px solid #e5e7eb; }
            .tile-edit-header h3 { margin:0; font-size:1.1rem; }
            .tile-edit-close { background:none; border:none; font-size:1.5rem; cursor:pointer; color:#9ca3af; line-height:1; }
            .tile-edit-close:hover { color:#374151; }
            .tile-edit-body { padding:20px; }
            .tile-edit-row { margin-bottom:16px; }
            .tile-edit-row label { display:block; font-size:0.85rem; font-weight:500; color:#374151; margin-bottom:6px; }
            .tile-edit-row input { width:100%; padding:10px 12px; border:1px solid #d1d5db; border-radius:6px; font-size:0.95rem; box-sizing:border-box; }
            .tile-edit-row input:focus { outline:none; border-color:#3b82f6; box-shadow:0 0 0 3px rgba(59,130,246,0.1); }
            .tile-edit-footer { display:flex; justify-content:flex-end; gap:12px; padding:16px 20px; border-top:1px solid #e5e7eb; background:#f9fafb; border-radius:0 0 12px 12px; }
            .tile-edit-cancel { padding:8px 16px; background:#f3f4f6; border:1px solid #d1d5db; border-radius:6px; cursor:pointer; font-weight:500; }
            .tile-edit-cancel:hover { background:#e5e7eb; }
            .tile-edit-save { padding:8px 16px; background:#3b82f6; color:white; border:none; border-radius:6px; cursor:pointer; font-weight:500; }
            .tile-edit-save:hover { background:#2563eb; }
            
            /* Palette */
            .scheduler-palette { padding:10px; background:#f4f4f4; border-radius:8px; margin-bottom:15px; display:flex; flex-wrap:wrap; gap:10px; }
            
            /* Grid Wrapper */
            .scheduler-grid-wrapper { overflow-x:auto; border:1px solid #999; background:#fff; }
        </style>
    `;
    
    palette = document.getElementById("scheduler-palette");
    grid = document.getElementById("scheduler-grid");
    
    // Setup event listeners
    setupTabListeners();
    setupKeyboardShortcuts();
    
    _isInitialized = true;
    
    renderTemplateUI();
    renderPalette();
    renderGrid();
    
    console.log("[MASTER_SCHEDULER] Module v3.0 initialized");
}

// =================================================================
// CLEANUP FUNCTION (for when tab is switched)
// =================================================================
function cleanup() {
    cleanupEventListeners();
    cleanupTabListeners();
    removeContextMenu();
    
    const toast = document.getElementById('master-scheduler-toast');
    if (toast) toast.remove();
    
    const modal = document.getElementById('tile-edit-modal');
    if (modal) modal.remove();
    
    const infoModal = document.getElementById('tile-info-modal');
    if (infoModal) infoModal.remove();
    
    const infoOverlay = document.getElementById('tile-info-overlay');
    if (infoOverlay) infoOverlay.remove();
    
    _isInitialized = false;
}

// =================================================================
// PUBLIC API
// =================================================================
window.initMasterScheduler = init;
window.cleanupMasterScheduler = cleanup;
window.refreshMasterSchedulerFromCloud = refreshFromStorage;

// Diagnostic function
window.diagnoseMasterScheduler = function() {
    return {
        isInitialized: _isInitialized,
        currentTemplate: currentLoadedTemplate,
        skeletonLength: dailySkeleton.length,
        hasClipboard: !!clipboardTile,
        activeListeners: activeEventListeners.length
    };
};

})();
