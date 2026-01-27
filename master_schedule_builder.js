// =================================================================
// master_schedule_builder.js (PRODUCTION-READY v4.0)
// =================================================================
// CHANGELOG v4.0:
// - Professional UI (no emojis/symbols)
// - Auto-save drafts (no popup on load)
// - In-app tile configuration modal (no browser prompts)
// - Time picker with increment buttons
// - Multi-select checkboxes for fields/locations
// - Integrated template management (Load/Update/Save/Delete)
// - Timeline uses camp's actual start/end times
// - Tile colors match between palette and grid
// - Locations include all facilities from Locations tab
// =================================================================

(function(){
'use strict';

console.log("[MASTER_SCHEDULER] Module v4.0 loading...");

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
let _autoSaveTimeout = null;

// Clipboard for copy/paste
let clipboardTile = null;
let lastHoveredCell = null;

// Event listener tracking for cleanup
let activeEventListeners = [];
let _visibilityHandler = null;
let _focusHandler = null;
let _keyboardHandler = null;

// Constants
const SKELETON_DRAFT_KEY = 'master-schedule-draft';
const SKELETON_DRAFT_NAME_KEY = 'master-schedule-draft-name';
const PIXELS_PER_MINUTE = 2;
const INCREMENT_MINS = 30;
const SNAP_MINS = 5;
const AUTO_SAVE_DELAY = 2000;

// =================================================================
// EVENT LISTENER MANAGEMENT
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
    if (_autoSaveTimeout) {
        clearTimeout(_autoSaveTimeout);
        _autoSaveTimeout = null;
    }
}

// =================================================================
// TAB VISIBILITY & CLOUD SYNC
// =================================================================
function setupTabListeners() {
    cleanupTabListeners();
    
    _visibilityHandler = () => {
        if (document.visibilityState === 'visible' && _isInitialized) {
            clearTimeout(_refreshTimeout);
            _refreshTimeout = setTimeout(() => {
                refreshFromStorage();
            }, 150);
        }
    };
    document.addEventListener('visibilitychange', _visibilityHandler);
    trackEventListener('visibilitychange', _visibilityHandler, document);
    
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

// =================================================================
// KEYBOARD SHORTCUTS
// =================================================================
function setupKeyboardShortcuts() {
    if (_keyboardHandler) {
        document.removeEventListener('keydown', _keyboardHandler);
    }
    
    _keyboardHandler = (e) => {
        const masterTab = document.getElementById('master-scheduler');
        if (!masterTab || !masterTab.classList.contains('active')) return;
        
        // Ctrl+C - Copy
        if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
            const selected = grid?.querySelector('.ms-event.selected');
            if (selected) {
                const eventId = selected.dataset.id;
                const event = dailySkeleton.find(ev => ev.id === eventId);
                if (event) {
                    copyTileToClipboard(event);
                    showToast('Tile copied');
                    e.preventDefault();
                }
            }
        }
        
        // Ctrl+V - Paste
        if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
            if (clipboardTile && lastHoveredCell) {
                pasteTileFromClipboard(lastHoveredCell);
                showToast('Tile pasted');
                e.preventDefault();
            }
        }
        
        // Delete key
        if (e.key === 'Delete' || e.key === 'Backspace') {
            const selected = grid?.querySelector('.ms-event.selected');
            if (selected && !e.target.matches('input, textarea, select')) {
                const eventId = selected.dataset.id;
                if (eventId && confirm("Delete this block?")) {
                    dailySkeleton = dailySkeleton.filter(x => x.id !== eventId);
                    scheduleAutoSave();
                    renderGrid();
                }
                e.preventDefault();
            }
        }
    };
    
    document.addEventListener('keydown', _keyboardHandler);
    trackEventListener('keydown', _keyboardHandler, document);
}

// =================================================================
// CLIPBOARD FUNCTIONS
// =================================================================
function copyTileToClipboard(event) {
    if (!event) return;
    clipboardTile = { ...event, id: null, _copiedAt: Date.now() };
}

function pasteTileFromClipboard(targetCell) {
    if (!clipboardTile || !targetCell) return;
    
    const divName = targetCell.dataset.div;
    const cellStartMin = parseInt(targetCell.dataset.startMin, 10) || 540;
    
    const origStart = parseTimeToMinutes(clipboardTile.startTime);
    const origEnd = parseTimeToMinutes(clipboardTile.endTime);
    const duration = (origStart !== null && origEnd !== null) ? (origEnd - origStart) : INCREMENT_MINS;
    
    const newEvent = {
        ...clipboardTile,
        id: generateId(),
        division: divName,
        startTime: minutesToTime(cellStartMin),
        endTime: minutesToTime(cellStartMin + duration)
    };
    delete newEvent._copiedAt;
    
    dailySkeleton.push(newEvent);
    scheduleAutoSave();
    renderGrid();
}

// =================================================================
// TOAST NOTIFICATION
// =================================================================
function showToast(message, duration = 2000) {
    let toast = document.getElementById('master-scheduler-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'master-scheduler-toast';
        document.body.appendChild(toast);
    }
    
    toast.textContent = message;
    toast.className = 'ms-toast ms-toast-show';
    
    setTimeout(() => {
        toast.className = 'ms-toast';
    }, duration);
}

// =================================================================
// UTILITY FUNCTIONS
// =================================================================
function generateId() {
    return Date.now().toString() + Math.random().toString(36).substr(2, 5);
}

function parseTimeToMinutes(str) {
    if (!str) return null;
    try {
        let s = str.toLowerCase().replace(/\s/g, '').replace(/am|pm/g, match => ' ' + match).trim();
        const isPM = s.includes('pm');
        const isAM = s.includes('am');
        s = s.replace(/am|pm/g, '').trim();
        let [h, m] = s.split(':').map(Number);
        if (isNaN(h)) return null;
        if (isPM && h !== 12) h += 12;
        if (isAM && h === 12) h = 0;
        return h * 60 + (m || 0);
    } catch (e) {
        return null;
    }
}

function minutesToTime(min) {
    if (min === null || min === undefined || isNaN(min)) return '';
    let h = Math.floor(min / 60);
    let m = min % 60;
    let ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${m.toString().padStart(2, '0')} ${ap}`;
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// =================================================================
// AUTO-SAVE DRAFT SYSTEM
// =================================================================
function scheduleAutoSave() {
    clearTimeout(_autoSaveTimeout);
    _autoSaveTimeout = setTimeout(() => {
        saveDraftToLocalStorage();
    }, AUTO_SAVE_DELAY);
}

function saveDraftToLocalStorage() {
    try {
        if (dailySkeleton && dailySkeleton.length > 0) {
            localStorage.setItem(SKELETON_DRAFT_KEY, JSON.stringify(dailySkeleton));
            if (currentLoadedTemplate) {
                localStorage.setItem(SKELETON_DRAFT_NAME_KEY, currentLoadedTemplate);
            } else {
                localStorage.removeItem(SKELETON_DRAFT_NAME_KEY);
            }
            updateDraftIndicator(true);
        } else {
            localStorage.removeItem(SKELETON_DRAFT_KEY);
            localStorage.removeItem(SKELETON_DRAFT_NAME_KEY);
            updateDraftIndicator(false);
        }
    } catch (e) {
        console.error('[MasterScheduler] Failed to save draft:', e);
    }
}

function clearDraftFromLocalStorage() {
    try {
        localStorage.removeItem(SKELETON_DRAFT_KEY);
        localStorage.removeItem(SKELETON_DRAFT_NAME_KEY);
        updateDraftIndicator(false);
    } catch (e) {
        console.warn('[MasterScheduler] Failed to clear draft:', e);
    }
}

function loadDraftFromLocalStorage() {
    try {
        const savedDraft = localStorage.getItem(SKELETON_DRAFT_KEY);
        const savedDraftName = localStorage.getItem(SKELETON_DRAFT_NAME_KEY);
        
        if (savedDraft) {
            dailySkeleton = JSON.parse(savedDraft);
            if (savedDraftName) {
                currentLoadedTemplate = savedDraftName;
            }
            return true;
        }
    } catch (e) {
        console.warn('[MasterScheduler] Failed to load draft:', e);
    }
    return false;
}

function updateDraftIndicator(hasUnsaved) {
    const indicator = document.getElementById('draft-indicator');
    if (indicator) {
        indicator.style.display = hasUnsaved ? 'inline' : 'none';
    }
}

// =================================================================
// REFRESH FROM CLOUD
// =================================================================
function refreshFromStorage() {
    try {
        if (currentLoadedTemplate) {
            const all = window.getSavedSkeletons?.() || {};
            if (all[currentLoadedTemplate]) {
                const cloudVersion = all[currentLoadedTemplate];
                if (JSON.stringify(cloudVersion) !== JSON.stringify(dailySkeleton)) {
                    // Don't auto-overwrite - just refresh template list
                }
            }
        }
        renderTemplateUI();
    } catch (e) {
        console.warn('[MasterScheduler] Refresh failed:', e);
    }
}

// =================================================================
// GET CAMP TIME RANGE
// =================================================================
function getCampTimeRange() {
    const divisions = window.divisions || {};
    const divNames = Object.keys(divisions).filter(d => divisions[d]?.bunks?.length > 0);
    
    let earliestMin = null;
    let latestMin = null;
    
    // Debug logging
    console.log('[MasterScheduler] getCampTimeRange - checking', divNames.length, 'divisions');
    
    // Get actual times from divisions
    divNames.forEach(d => {
        const div = divisions[d];
        const s = parseTimeToMinutes(div?.startTime);
        const e = parseTimeToMinutes(div?.endTime);
        console.log(`[MasterScheduler] Division "${d}": start=${div?.startTime} (${s} min), end=${div?.endTime} (${e} min)`);
        if (s !== null) {
            if (earliestMin === null || s < earliestMin) earliestMin = s;
        }
        if (e !== null) {
            if (latestMin === null || e > latestMin) latestMin = e;
        }
    });
    
    // Also check skeleton events (may extend beyond division times)
    dailySkeleton.forEach(ev => {
        const s = parseTimeToMinutes(ev.startTime);
        const e = parseTimeToMinutes(ev.endTime);
        if (s !== null && (earliestMin === null || s < earliestMin)) earliestMin = s;
        if (e !== null && (latestMin === null || e > latestMin)) latestMin = e;
    });
    
    // Fallback defaults only if no data found
    if (earliestMin === null) {
        console.log('[MasterScheduler] No division start times found, using default 9:00 AM');
        earliestMin = 540;
    }
    if (latestMin === null) {
        console.log('[MasterScheduler] No division end times found, using default 4:00 PM');
        latestMin = 960;
    }
    
    // Ensure minimum 1 hour range
    if (latestMin - earliestMin < 60) {
        latestMin = earliestMin + 60;
    }
    
    console.log(`[MasterScheduler] Final time range: ${minutesToTime(earliestMin)} - ${minutesToTime(latestMin)}`);
    
    return { earliestMin, latestMin };
}

// =================================================================
// GET ALL AVAILABLE FIELDS AND LOCATIONS
// =================================================================
function getAllFieldsAndLocations() {
    const globalSettings = window.loadGlobalSettings?.() || {};
    const result = {
        fields: [],
        locations: [],
        all: []
    };
    
    // Get fields
    const fields = globalSettings.app1?.fields || [];
    fields.forEach(f => {
        if (f.available !== false) {
            result.fields.push({ name: f.name, type: 'field' });
            result.all.push({ name: f.name, type: 'field' });
        }
    });
    
    // Get locations from location zones
    const zones = globalSettings.locationZones || {};
    Object.values(zones).forEach(zone => {
        if (zone.locations) {
            Object.keys(zone.locations).forEach(locName => {
                if (!result.all.find(x => x.name === locName)) {
                    result.locations.push({ name: locName, type: 'location', zone: zone.name });
                    result.all.push({ name: locName, type: 'location', zone: zone.name });
                }
            });
        }
    });
    
    // Get special activities that might have locations
    const specials = globalSettings.app1?.specialActivities || [];
    specials.forEach(s => {
        if (s.location && !result.all.find(x => x.name === s.location)) {
            result.locations.push({ name: s.location, type: 'facility' });
            result.all.push({ name: s.location, type: 'facility' });
        }
    });
    
    return result;
}

// =================================================================
// TILES DEFINITION
// =================================================================
const TILES = [
    { type: 'activity', name: 'Activity', color: '#e0f7fa', border: '#007bff', description: 'Flexible slot (Sport or Special).' },
    { type: 'sports', name: 'Sports', color: '#dcedc8', border: '#689f38', description: 'Sports slot only.' },
    { type: 'special', name: 'Special Activity', color: '#e8f5e9', border: '#43a047', description: 'Special Activity slot only.' },
    { type: 'smart', name: 'Smart Tile', color: '#e3f2fd', border: '#0288d1', description: 'Balances 2 activities with a fallback.', dashed: true },
    { type: 'split', name: 'Split Activity', color: '#fff3e0', border: '#f57c00', description: 'Two activities share the block.' },
    { type: 'elective', name: 'Elective', color: '#e1bee7', border: '#8e24aa', description: 'Reserve multiple activities for division.' },
    { type: 'league', name: 'League Game', color: '#d1c4e9', border: '#5e35b1', description: 'Regular League slot.' },
    { type: 'specialty_league', name: 'Specialty League', color: '#fff8e1', border: '#f9a825', description: 'Specialty League slot.' },
    { type: 'swim', name: 'Swim', color: '#bbdefb', border: '#1976d2', description: 'Pinned swim time.' },
    { type: 'lunch', name: 'Lunch', color: '#fbe9e7', border: '#d84315', description: 'Pinned lunch time.' },
    { type: 'snacks', name: 'Snacks', color: '#fff9c4', border: '#fbc02d', description: 'Pinned snack time.' },
    { type: 'dismissal', name: 'Dismissal', color: '#ffcdd2', border: '#c62828', description: 'Pinned dismissal.' },
    { type: 'custom', name: 'Custom Event', color: '#eceff1', border: '#616161', description: 'Custom pinned event.' }
];

function getTileStyle(tile) {
    const borderStyle = tile.dashed ? 'dashed' : 'solid';
    return `background:${tile.color};border:2px ${borderStyle} ${tile.border};`;
}

function getTileByType(type) {
    return TILES.find(t => t.type === type) || TILES.find(t => t.type === 'custom');
}

// =================================================================
// TILE CONFIGURATION MODAL
// =================================================================
function showTileConfigModal(tileType, divisionName, initialStartMin, callback) {
    const tile = getTileByType(tileType);
    if (!tile) return;
    
    // Remove existing modal
    const existingModal = document.getElementById('tile-config-modal');
    if (existingModal) existingModal.remove();
    
    const { earliestMin, latestMin } = getCampTimeRange();
    const allLocations = getAllFieldsAndLocations();
    
    // Default times
    let startMin = initialStartMin || earliestMin;
    let endMin = startMin + INCREMENT_MINS;
    
    const modal = document.createElement('div');
    modal.id = 'tile-config-modal';
    modal.className = 'ms-modal-overlay';
    
    // Build location checkboxes
    let locationCheckboxes = '';
    if (allLocations.all.length > 0) {
        const fieldItems = allLocations.fields.map(f => 
            `<label class="ms-checkbox-item"><input type="checkbox" name="reserved-location" value="${escapeHtml(f.name)}"><span>${escapeHtml(f.name)}</span><span class="ms-location-type">Field</span></label>`
        ).join('');
        
        const locationItems = allLocations.locations.map(l => 
            `<label class="ms-checkbox-item"><input type="checkbox" name="reserved-location" value="${escapeHtml(l.name)}"><span>${escapeHtml(l.name)}</span><span class="ms-location-type">${escapeHtml(l.zone || 'Location')}</span></label>`
        ).join('');
        
        locationCheckboxes = `
            <div class="ms-form-group">
                <label class="ms-label">Reserve Fields / Locations</label>
                <div class="ms-checkbox-grid">
                    ${fieldItems}
                    ${locationItems}
                </div>
            </div>
        `;
    }
    
    // Build special fields for different tile types
    let specialFields = '';
    
    if (tileType === 'smart') {
        specialFields = `
            <div class="ms-form-row">
                <div class="ms-form-group ms-form-half">
                    <label class="ms-label">Activity 1</label>
                    <input type="text" id="modal-activity1" class="ms-input" placeholder="e.g., Swim">
                </div>
                <div class="ms-form-group ms-form-half">
                    <label class="ms-label">Activity 2</label>
                    <input type="text" id="modal-activity2" class="ms-input" placeholder="e.g., Art">
                </div>
            </div>
            <div class="ms-form-row">
                <div class="ms-form-group ms-form-half">
                    <label class="ms-label">Fallback For</label>
                    <select id="modal-fallback-for" class="ms-select">
                        <option value="1">Activity 1</option>
                        <option value="2">Activity 2</option>
                    </select>
                </div>
                <div class="ms-form-group ms-form-half">
                    <label class="ms-label">Fallback Activity</label>
                    <input type="text" id="modal-fallback" class="ms-input" placeholder="e.g., Gaga">
                </div>
            </div>
        `;
    } else if (tileType === 'split') {
        specialFields = `
            <div class="ms-form-row">
                <div class="ms-form-group ms-form-half">
                    <label class="ms-label">First Activity</label>
                    <input type="text" id="modal-split1" class="ms-input" placeholder="e.g., Swim">
                </div>
                <div class="ms-form-group ms-form-half">
                    <label class="ms-label">Second Activity</label>
                    <input type="text" id="modal-split2" class="ms-input" placeholder="e.g., Art">
                </div>
            </div>
        `;
    } else if (tileType === 'elective') {
        const activities = [
            ...allLocations.fields.map(f => f.name),
            ...(window.loadGlobalSettings?.()?.app1?.specialActivities || []).filter(s => s.available !== false).map(s => s.name)
        ];
        const activityCheckboxes = activities.map(a => 
            `<label class="ms-checkbox-item"><input type="checkbox" name="elective-activity" value="${escapeHtml(a)}"><span>${escapeHtml(a)}</span></label>`
        ).join('');
        
        specialFields = `
            <div class="ms-form-group">
                <label class="ms-label">Elective Activities (select 2+)</label>
                <div class="ms-checkbox-grid">
                    ${activityCheckboxes}
                </div>
            </div>
        `;
    } else if (tileType === 'custom') {
        specialFields = `
            <div class="ms-form-group">
                <label class="ms-label">Event Name</label>
                <input type="text" id="modal-custom-name" class="ms-input" placeholder="e.g., Regroup, Assembly">
            </div>
        `;
    }
    
    modal.innerHTML = `
        <div class="ms-modal">
            <div class="ms-modal-header">
                <h3>${escapeHtml(tile.name)}</h3>
                <button class="ms-modal-close" id="modal-close">&times;</button>
            </div>
            <div class="ms-modal-body">
                <p class="ms-modal-desc">${escapeHtml(tile.description)}</p>
                
                <div class="ms-form-group">
                    <label class="ms-label">Time</label>
                    <div class="ms-time-picker">
                        <div class="ms-time-section">
                            <span class="ms-time-label">Start</span>
                            <div class="ms-time-control">
                                <button type="button" class="ms-time-btn" data-action="start-down">-</button>
                                <input type="text" id="modal-start-time" class="ms-time-input" value="${minutesToTime(startMin)}">
                                <button type="button" class="ms-time-btn" data-action="start-up">+</button>
                            </div>
                        </div>
                        <span class="ms-time-separator">to</span>
                        <div class="ms-time-section">
                            <span class="ms-time-label">End</span>
                            <div class="ms-time-control">
                                <button type="button" class="ms-time-btn" data-action="end-down">-</button>
                                <input type="text" id="modal-end-time" class="ms-time-input" value="${minutesToTime(endMin)}">
                                <button type="button" class="ms-time-btn" data-action="end-up">+</button>
                            </div>
                        </div>
                    </div>
                    <div class="ms-time-presets">
                        <span class="ms-presets-label">Duration:</span>
                        <button type="button" class="ms-preset-btn" data-duration="15">15 min</button>
                        <button type="button" class="ms-preset-btn" data-duration="30">30 min</button>
                        <button type="button" class="ms-preset-btn" data-duration="45">45 min</button>
                        <button type="button" class="ms-preset-btn" data-duration="60">1 hour</button>
                    </div>
                </div>
                
                ${specialFields}
                ${!['smart', 'split', 'elective'].includes(tileType) ? locationCheckboxes : ''}
            </div>
            <div class="ms-modal-footer">
                <button class="ms-btn ms-btn-secondary" id="modal-cancel">Cancel</button>
                <button class="ms-btn ms-btn-primary" id="modal-confirm">Add to Schedule</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Time control state
    let currentStart = startMin;
    let currentEnd = endMin;
    
    const startInput = document.getElementById('modal-start-time');
    const endInput = document.getElementById('modal-end-time');
    
    const updateTimeDisplays = () => {
        if (startInput) startInput.value = minutesToTime(currentStart);
        if (endInput) endInput.value = minutesToTime(currentEnd);
    };
    
    // Handle typing in time inputs
    if (startInput) {
        startInput.addEventListener('blur', () => {
            const parsed = parseTimeToMinutes(startInput.value);
            if (parsed !== null) {
                currentStart = parsed;
                if (currentStart >= currentEnd) {
                    currentEnd = currentStart + 30;
                }
            }
            updateTimeDisplays();
        });
        startInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                startInput.blur();
            }
        });
    }
    
    if (endInput) {
        endInput.addEventListener('blur', () => {
            const parsed = parseTimeToMinutes(endInput.value);
            if (parsed !== null && parsed > currentStart) {
                currentEnd = parsed;
            }
            updateTimeDisplays();
        });
        endInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                endInput.blur();
            }
        });
    }
    
    // Time button handlers
    modal.querySelectorAll('.ms-time-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const action = btn.dataset.action;
            const step = 5;
            
            if (action === 'start-up') {
                currentStart = Math.min(currentStart + step, currentEnd - step);
            } else if (action === 'start-down') {
                currentStart = Math.max(currentStart - step, 0);
            } else if (action === 'end-up') {
                currentEnd = Math.min(currentEnd + step, 1440);
            } else if (action === 'end-down') {
                currentEnd = Math.max(currentEnd - step, currentStart + step);
            }
            
            updateTimeDisplays();
        });
    });
    
    // Preset duration buttons
    modal.querySelectorAll('.ms-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const duration = parseInt(btn.dataset.duration, 10);
            currentEnd = currentStart + duration;
            updateTimeDisplays();
        });
    });
    
    // Close handlers
    const closeModal = () => modal.remove();
    
    modal.querySelector('#modal-close').addEventListener('click', closeModal);
    modal.querySelector('#modal-cancel').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });
    
    // Confirm handler
    modal.querySelector('#modal-confirm').addEventListener('click', () => {
        // Build the event object
        const newEvent = {
            id: generateId(),
            type: tileType,
            event: tile.name,
            division: divisionName,
            startTime: minutesToTime(currentStart),
            endTime: minutesToTime(currentEnd),
            reservedFields: []
        };
        
        // Get reserved locations
        modal.querySelectorAll('input[name="reserved-location"]:checked').forEach(cb => {
            newEvent.reservedFields.push(cb.value);
        });
        
        // Handle special tile types
        if (tileType === 'smart') {
            const act1 = modal.querySelector('#modal-activity1')?.value.trim();
            const act2 = modal.querySelector('#modal-activity2')?.value.trim();
            const fallbackFor = modal.querySelector('#modal-fallback-for')?.value;
            const fallback = modal.querySelector('#modal-fallback')?.value.trim();
            
            if (!act1 || !act2) {
                alert('Please enter both activities.');
                return;
            }
            if (!fallback) {
                alert('Please enter a fallback activity.');
                return;
            }
            
            newEvent.smartData = {
                activity1: act1,
                activity2: act2,
                fallbackFor: fallbackFor === '1' ? act1 : act2,
                fallbackActivity: fallback
            };
        } else if (tileType === 'split') {
            const split1 = modal.querySelector('#modal-split1')?.value.trim();
            const split2 = modal.querySelector('#modal-split2')?.value.trim();
            
            if (!split1 || !split2) {
                alert('Please enter both activities.');
                return;
            }
            
            const midMin = currentStart + Math.floor((currentEnd - currentStart) / 2);
            newEvent.subEvents = [
                { activity: split1, startTime: minutesToTime(currentStart), endTime: minutesToTime(midMin) },
                { activity: split2, startTime: minutesToTime(midMin), endTime: minutesToTime(currentEnd) }
            ];
        } else if (tileType === 'elective') {
            const selected = [];
            modal.querySelectorAll('input[name="elective-activity"]:checked').forEach(cb => {
                selected.push(cb.value);
            });
            
            if (selected.length < 2) {
                alert('Please select at least 2 activities for the elective.');
                return;
            }
            
            newEvent.electiveActivities = selected;
        } else if (tileType === 'custom') {
            const customName = modal.querySelector('#modal-custom-name')?.value.trim();
            if (!customName) {
                alert('Please enter an event name.');
                return;
            }
            newEvent.event = customName;
        }
        
        // Set default location if available
        const defaultLocation = window.getPinnedTileDefaultLocation?.(newEvent.event);
        if (defaultLocation) {
            newEvent.location = defaultLocation;
        }
        
        closeModal();
        callback(newEvent);
    });
}

// =================================================================
// TILE EDIT MODAL
// =================================================================
function showTileEditModal(event) {
    if (!event) return;
    
    const existingModal = document.getElementById('tile-edit-modal');
    if (existingModal) existingModal.remove();
    
    const { earliestMin, latestMin } = getCampTimeRange();
    let currentStart = parseTimeToMinutes(event.startTime) || earliestMin;
    let currentEnd = parseTimeToMinutes(event.endTime) || (currentStart + 30);
    
    const modal = document.createElement('div');
    modal.id = 'tile-edit-modal';
    modal.className = 'ms-modal-overlay';
    modal.innerHTML = `
        <div class="ms-modal ms-modal-sm">
            <div class="ms-modal-header">
                <h3>Edit Tile</h3>
                <button class="ms-modal-close" id="edit-modal-close">&times;</button>
            </div>
            <div class="ms-modal-body">
                <div class="ms-form-group">
                    <label class="ms-label">Event Name</label>
                    <input type="text" id="edit-name" class="ms-input" value="${escapeHtml(event.event || '')}">
                </div>
                <div class="ms-form-group">
                    <label class="ms-label">Time</label>
                    <div class="ms-time-picker">
                        <div class="ms-time-section">
                            <span class="ms-time-label">Start</span>
                            <div class="ms-time-control">
                                <button type="button" class="ms-time-btn" data-action="start-down">-</button>
                                <input type="text" id="edit-start-time" class="ms-time-input" value="${minutesToTime(currentStart)}">
                                <button type="button" class="ms-time-btn" data-action="start-up">+</button>
                            </div>
                        </div>
                        <span class="ms-time-separator">to</span>
                        <div class="ms-time-section">
                            <span class="ms-time-label">End</span>
                            <div class="ms-time-control">
                                <button type="button" class="ms-time-btn" data-action="end-down">-</button>
                                <input type="text" id="edit-end-time" class="ms-time-input" value="${minutesToTime(currentEnd)}">
                                <button type="button" class="ms-time-btn" data-action="end-up">+</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="ms-modal-footer">
                <button class="ms-btn ms-btn-secondary" id="edit-modal-cancel">Cancel</button>
                <button class="ms-btn ms-btn-primary" id="edit-modal-save">Save Changes</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    const startInput = document.getElementById('edit-start-time');
    const endInput = document.getElementById('edit-end-time');
    
    const updateTimeDisplays = () => {
        if (startInput) startInput.value = minutesToTime(currentStart);
        if (endInput) endInput.value = minutesToTime(currentEnd);
    };
    
    // Handle typing in time inputs
    if (startInput) {
        startInput.addEventListener('blur', () => {
            const parsed = parseTimeToMinutes(startInput.value);
            if (parsed !== null) {
                currentStart = parsed;
                if (currentStart >= currentEnd) {
                    currentEnd = currentStart + 30;
                }
            }
            updateTimeDisplays();
        });
    }
    
    if (endInput) {
        endInput.addEventListener('blur', () => {
            const parsed = parseTimeToMinutes(endInput.value);
            if (parsed !== null && parsed > currentStart) {
                currentEnd = parsed;
            }
            updateTimeDisplays();
        });
    }
    
    modal.querySelectorAll('.ms-time-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const action = btn.dataset.action;
            const step = 5;
            
            if (action === 'start-up') currentStart = Math.min(currentStart + step, currentEnd - step);
            else if (action === 'start-down') currentStart = Math.max(currentStart - step, 0);
            else if (action === 'end-up') currentEnd = Math.min(currentEnd + step, 1440);
            else if (action === 'end-down') currentEnd = Math.max(currentEnd - step, currentStart + step);
            
            updateTimeDisplays();
        });
    });
    
    const closeModal = () => modal.remove();
    modal.querySelector('#edit-modal-close').addEventListener('click', closeModal);
    modal.querySelector('#edit-modal-cancel').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
    
    modal.querySelector('#edit-modal-save').addEventListener('click', () => {
        const newName = modal.querySelector('#edit-name').value.trim();
        if (!newName) {
            alert('Event name is required.');
            return;
        }
        
        const idx = dailySkeleton.findIndex(ev => ev.id === event.id);
        if (idx !== -1) {
            dailySkeleton[idx].event = newName;
            dailySkeleton[idx].startTime = minutesToTime(currentStart);
            dailySkeleton[idx].endTime = minutesToTime(currentEnd);
            scheduleAutoSave();
            renderGrid();
            showToast('Tile updated');
        }
        closeModal();
    });
}

// =================================================================
// CONTEXT MENU
// =================================================================
function showTileContextMenu(e, event) {
    e.preventDefault();
    e.stopPropagation();
    
    removeContextMenu();
    
    const menu = document.createElement('div');
    menu.id = 'tile-context-menu';
    menu.className = 'ms-context-menu';
    menu.innerHTML = `
        <div class="ms-context-item" data-action="copy">Copy</div>
        <div class="ms-context-item" data-action="edit">Edit</div>
    `;
    
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    document.body.appendChild(menu);
    
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 10) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 10) + 'px';
    
    menu.addEventListener('click', (evt) => {
        const action = evt.target.dataset.action;
        if (action === 'copy') {
            copyTileToClipboard(event);
            showToast('Tile copied');
        } else if (action === 'edit') {
            showTileEditModal(event);
        }
        removeContextMenu();
    });
    
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
            clearDraftFromLocalStorage();
        }
        renderGrid();
        renderTemplateUI();
    } catch (e) {
        console.error('[MasterScheduler] Failed to load skeleton:', name, e);
    }
}

// =================================================================
// TEMPLATE UI
// =================================================================
function renderTemplateUI() {
    const ui = document.getElementById("scheduler-template-ui");
    if (!ui) return;
    
    try {
        const saved = window.getSavedSkeletons?.() || {};
        const names = Object.keys(saved).sort();
        const hasDraft = dailySkeleton.length > 0;
        const isEditing = !!currentLoadedTemplate;
        
        const templateOptions = names.map(n => 
            `<option value="${escapeHtml(n)}" ${currentLoadedTemplate === n ? 'selected' : ''}>${escapeHtml(n)}</option>`
        ).join('');
        
        ui.innerHTML = `
            <div class="ms-template-bar">
                <div class="ms-template-status">
                    ${isEditing 
                        ? `<span class="ms-status-editing">Editing: <strong>${escapeHtml(currentLoadedTemplate)}</strong></span>` 
                        : '<span class="ms-status-new">New Schedule</span>'}
                    <span id="draft-indicator" class="ms-draft-indicator" style="display:${hasDraft ? 'inline' : 'none'}">Unsaved changes</span>
                </div>
                
                <div class="ms-template-actions">
                    <div class="ms-action-group">
                        <select id="template-select" class="ms-select">
                            <option value="">Load Template...</option>
                            ${templateOptions}
                        </select>
                    </div>
                    
                    ${isEditing ? `
                    <button id="btn-update" class="ms-btn ms-btn-primary">Update</button>
                    ` : ''}
                    
                    <div class="ms-action-group ms-save-group">
                        <input type="text" id="save-name-input" class="ms-input ms-input-sm" placeholder="Template name..." value="">
                        <button id="btn-save" class="ms-btn ms-btn-success">Save New</button>
                    </div>
                    
                    <button id="btn-clear" class="ms-btn ms-btn-secondary">Clear</button>
                    
                    ${names.length > 0 ? `
                    <div class="ms-action-group ms-delete-group">
                        <select id="delete-select" class="ms-select ms-select-sm">
                            <option value="">Delete...</option>
                            ${templateOptions}
                        </select>
                        <button id="btn-delete" class="ms-btn ms-btn-danger">Delete</button>
                    </div>
                    ` : ''}
                </div>
            </div>
        `;
        
        // Bind handlers
        bindTemplateHandlers(saved);
        
    } catch (e) {
        console.error('[MasterScheduler] Failed to render template UI:', e);
    }
}

function bindTemplateHandlers(saved) {
    // Load template
    const selectEl = document.getElementById('template-select');
    if (selectEl) {
        selectEl.addEventListener('change', () => {
            const name = selectEl.value;
            if (name && saved[name]) {
                if (dailySkeleton.length > 0) {
                    if (!confirm(`Load "${name}"? Unsaved changes will be lost.`)) {
                        selectEl.value = currentLoadedTemplate || '';
                        return;
                    }
                }
                loadSkeletonToBuilder(name);
            }
        });
    }
    
    // Update button
    const updateBtn = document.getElementById('btn-update');
    if (updateBtn) {
        updateBtn.addEventListener('click', () => {
            if (!window.AccessControl?.checkSetupAccess?.('update schedule templates')) return;
            
            if (currentLoadedTemplate) {
                window.saveSkeleton?.(currentLoadedTemplate, dailySkeleton);
                window.forceSyncToCloud?.();
                clearDraftFromLocalStorage();
                showToast('Template updated');
                renderTemplateUI();
            }
        });
    }
    
    // Save new button
    const saveBtn = document.getElementById('btn-save');
    const saveInput = document.getElementById('save-name-input');
    if (saveBtn && saveInput) {
        saveBtn.addEventListener('click', () => {
            if (!window.AccessControl?.checkSetupAccess?.('save schedule templates')) return;
            
            const name = saveInput.value.trim();
            if (!name) {
                alert('Please enter a template name.');
                saveInput.focus();
                return;
            }
            
            if (saved[name] && !confirm(`"${name}" already exists. Overwrite?`)) return;
            
            window.saveSkeleton?.(name, dailySkeleton);
            window.forceSyncToCloud?.();
            currentLoadedTemplate = name;
            clearDraftFromLocalStorage();
            showToast('Template saved');
            renderTemplateUI();
        });
    }
    
    // Clear button
    const clearBtn = document.getElementById('btn-clear');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            if (dailySkeleton.length > 0 && !confirm('Clear the schedule?')) return;
            
            dailySkeleton = [];
            currentLoadedTemplate = null;
            clearDraftFromLocalStorage();
            renderGrid();
            renderTemplateUI();
        });
    }
    
    // Delete button
    const deleteBtn = document.getElementById('btn-delete');
    const deleteSelect = document.getElementById('delete-select');
    if (deleteBtn && deleteSelect) {
        deleteBtn.addEventListener('click', () => {
            if (!window.AccessControl?.checkSetupAccess?.('delete schedule templates')) return;
            
            const name = deleteSelect.value;
            if (!name) {
                alert('Please select a template to delete.');
                return;
            }
            
            if (!confirm(`Permanently delete "${name}"?`)) return;
            
            window.deleteSkeleton?.(name);
            window.forceSyncToCloud?.();
            
            if (currentLoadedTemplate === name) {
                currentLoadedTemplate = null;
                dailySkeleton = [];
                clearDraftFromLocalStorage();
                renderGrid();
            }
            
            showToast('Template deleted');
            renderTemplateUI();
        });
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
        el.className = 'ms-palette-tile';
        el.textContent = tile.name;
        el.style.cssText = getTileStyle(tile);
        el.draggable = true;
        el.title = tile.description;
        
        el.addEventListener('click', (e) => {
            if (e.detail === 1 && !el.dragging) {
                showToast(tile.description, 3000);
            }
        });
        
        el.addEventListener('dragstart', (e) => {
            el.dragging = true;
            e.dataTransfer.setData('application/json', JSON.stringify(tile));
        });
        el.addEventListener('dragend', () => { el.dragging = false; });
        
        // Mobile touch
        let touchStartY = 0;
        el.addEventListener('touchstart', (e) => {
            touchStartY = e.touches[0].clientY;
            el.dataset.tileData = JSON.stringify(tile);
            el.style.opacity = '0.6';
        });
        
        el.addEventListener('touchend', (e) => {
            el.style.opacity = '1';
            const touch = e.changedTouches[0];
            
            if (Math.abs(touch.clientY - touchStartY) < 10) {
                showToast(tile.description, 3000);
                return;
            }
            
            const dropTarget = document.elementFromPoint(touch.clientX, touch.clientY);
            const gridCell = dropTarget?.closest('.ms-grid-cell');
            if (gridCell) {
                handleTileDrop(tile, gridCell, touch.clientY);
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
            grid.innerHTML = `<p class="ms-empty-message">No divisions configured. Please set up divisions in the Setup tab first.</p>`;
            return;
        }
        
        const { earliestMin, latestMin } = getCampTimeRange();
        const totalHeight = (latestMin - earliestMin) * PIXELS_PER_MINUTE;
        
        let html = `<div class="ms-grid" style="grid-template-columns:60px repeat(${availableDivisions.length}, 1fr);">`;
        
        // Header row
        html += `<div class="ms-grid-corner"></div>`;
        availableDivisions.forEach(divName => {
            const color = divisions[divName]?.color || '#4a5568';
            html += `<div class="ms-grid-header" style="background:${color};">${escapeHtml(divName)}</div>`;
        });
        
        // Time column
        html += `<div class="ms-time-column" style="height:${totalHeight}px;">`;
        for (let m = earliestMin; m < latestMin; m += INCREMENT_MINS) {
            const top = (m - earliestMin) * PIXELS_PER_MINUTE;
            html += `<div class="ms-time-marker" style="top:${top}px;">${minutesToTime(m)}</div>`;
        }
        html += `</div>`;
        
        // Division columns
        availableDivisions.forEach(divName => {
            const div = divisions[divName];
            const s = parseTimeToMinutes(div?.startTime);
            const e = parseTimeToMinutes(div?.endTime);
            
            html += `<div class="ms-grid-cell" data-div="${escapeHtml(divName)}" data-start-min="${earliestMin}" style="height:${totalHeight}px;">`;
            
            // Grey out unavailable times
            if (s !== null && s > earliestMin) {
                html += `<div class="ms-disabled-zone" style="top:0;height:${(s - earliestMin) * PIXELS_PER_MINUTE}px;"></div>`;
            }
            if (e !== null && e < latestMin) {
                html += `<div class="ms-disabled-zone" style="top:${(e - earliestMin) * PIXELS_PER_MINUTE}px;height:${(latestMin - e) * PIXELS_PER_MINUTE}px;"></div>`;
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
            
            html += `<div class="ms-drop-preview"></div>`;
            html += `</div>`;
        });
        
        html += `</div>`;
        grid.innerHTML = html;
        grid.dataset.earliestMin = earliestMin;
        
        // Bind event listeners
        bindGridListeners();
        
    } catch (e) {
        console.error('[MasterScheduler] Failed to render grid:', e);
        grid.innerHTML = '<p class="ms-error-message">Error rendering schedule grid</p>';
    }
}

function renderEventTile(ev, top, height) {
    const tile = getTileByType(ev.type);
    
    // Build inline style with tile colors
    const borderStyle = tile.dashed ? 'dashed' : 'solid';
    const bgColor = tile.color;
    const borderColor = tile.border;
    
    const fontSize = height < 40 ? '0.7em' : '0.85em';
    const showDetails = height >= 50;
    const showResizeHandles = height >= 50;
    
    // For custom events, show the custom name prominently
    const displayName = ev.event || tile.name;
    
    let content = `<strong>${escapeHtml(displayName)}</strong>`;
    if (showDetails) {
        content += `<span class="ms-tile-time">${ev.startTime} - ${ev.endTime}</span>`;
    }
    
    if (ev.reservedFields?.length > 0 && height > 60) {
        content += `<span class="ms-tile-fields">${ev.reservedFields.join(', ')}</span>`;
    }
    
    return `
        <div class="ms-event ${height < 50 ? 'ms-event-small' : ''}" 
             data-id="${ev.id}" 
             draggable="true" 
             title="Double-click to delete"
             style="background:${bgColor}; border:2px ${borderStyle} ${borderColor}; top:${top}px; height:${height}px; font-size:${fontSize};">
            ${showResizeHandles ? '<div class="ms-resize-handle ms-resize-top"></div>' : ''}
            <div class="ms-event-content">${content}</div>
            ${showResizeHandles ? '<div class="ms-resize-handle ms-resize-bottom"></div>' : ''}
        </div>
    `;
}

// =================================================================
// GRID EVENT HANDLERS
// =================================================================
function bindGridListeners() {
    if (!grid) return;
    
    // Cell hover tracking for paste
    grid.querySelectorAll('.ms-grid-cell').forEach(cell => {
        cell.addEventListener('mouseenter', () => { lastHoveredCell = cell; });
        
        // Drop handlers
        cell.addEventListener('dragover', (e) => {
            e.preventDefault();
            cell.classList.add('ms-cell-hover');
        });
        
        cell.addEventListener('dragleave', (e) => {
            if (!cell.contains(e.relatedTarget)) {
                cell.classList.remove('ms-cell-hover');
            }
        });
        
        cell.addEventListener('drop', (e) => {
            e.preventDefault();
            cell.classList.remove('ms-cell-hover');
            
            // Handle tile move
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
                
                scheduleAutoSave();
                renderGrid();
                return;
            }
            
            // Handle new tile from palette
            try {
                const tileData = JSON.parse(e.dataTransfer?.getData('application/json') || '{}');
                if (tileData.type) {
                    handleTileDrop(tileData, cell, e.clientY);
                }
            } catch (err) {
                // Ignore
            }
        });
    });
    
    // Event tile handlers
    grid.querySelectorAll('.ms-event').forEach(tile => {
        const eventId = tile.dataset.id;
        const event = dailySkeleton.find(ev => ev.id === eventId);
        
        // Double-click to delete
        tile.addEventListener('dblclick', (e) => {
            if (e.target.classList.contains('ms-resize-handle')) return;
            if (confirm("Delete this block?")) {
                dailySkeleton = dailySkeleton.filter(x => x.id !== eventId);
                scheduleAutoSave();
                renderGrid();
            }
        });
        
        // Right-click context menu
        tile.addEventListener('contextmenu', (e) => {
            if (event) showTileContextMenu(e, event);
        });
        
        // Click to select
        tile.addEventListener('click', (e) => {
            if (e.target.classList.contains('ms-resize-handle')) return;
            grid.querySelectorAll('.ms-event.selected').forEach(t => t.classList.remove('selected'));
            tile.classList.add('selected');
        });
        
        // Drag to move
        tile.addEventListener('dragstart', (e) => {
            if (e.target.classList.contains('ms-resize-handle')) {
                e.preventDefault();
                return;
            }
            e.dataTransfer.setData('text/event-move', eventId);
            e.dataTransfer.effectAllowed = 'move';
            tile.style.opacity = '0.4';
        });
        
        tile.addEventListener('dragend', () => {
            tile.style.opacity = '1';
        });
        
        // Resize handles
        addResizeHandlers(tile, eventId);
    });
    
    // Click outside to deselect
    grid.addEventListener('click', (e) => {
        if (!e.target.closest('.ms-event')) {
            grid.querySelectorAll('.ms-event.selected').forEach(t => t.classList.remove('selected'));
        }
    });
}

function handleTileDrop(tileData, cell, clientY) {
    const divName = cell.dataset.div;
    const cellStartMin = parseInt(cell.dataset.startMin, 10) || 540;
    const rect = cell.getBoundingClientRect();
    const offsetY = clientY - rect.top;
    const snapMin = Math.round(offsetY / PIXELS_PER_MINUTE / 15) * 15;
    const startMin = cellStartMin + snapMin;
    
    showTileConfigModal(tileData.type, divName, startMin, (newEvent) => {
        dailySkeleton.push(newEvent);
        scheduleAutoSave();
        renderGrid();
    });
}

function addResizeHandlers(tile, eventId) {
    const { earliestMin } = getCampTimeRange();
    
    tile.querySelectorAll('.ms-resize-handle').forEach(handle => {
        const direction = handle.classList.contains('ms-resize-top') ? 'top' : 'bottom';
        
        let isResizing = false;
        let startY = 0;
        let startTop = 0;
        let startHeight = 0;
        
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            isResizing = true;
            startY = e.clientY;
            startTop = parseInt(tile.style.top, 10) || 0;
            startHeight = parseInt(tile.style.height, 10) || 60;
            
            tile.classList.add('resizing');
            
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
                
                const snappedTop = Math.round(newTop / (SNAP_MINS * PIXELS_PER_MINUTE)) * (SNAP_MINS * PIXELS_PER_MINUTE);
                const snappedHeight = Math.max(20, Math.round(newHeight / (SNAP_MINS * PIXELS_PER_MINUTE)) * (SNAP_MINS * PIXELS_PER_MINUTE));
                
                tile.style.top = snappedTop + 'px';
                tile.style.height = snappedHeight + 'px';
            };
            
            const onMouseUp = () => {
                if (!isResizing) return;
                isResizing = false;
                
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                tile.classList.remove('resizing');
                
                const event = dailySkeleton.find(ev => ev.id === eventId);
                if (!event) return;
                
                const newTop = parseInt(tile.style.top, 10) || 0;
                const newHeightPx = parseInt(tile.style.height, 10) || 60;
                const newStartMin = earliestMin + (newTop / PIXELS_PER_MINUTE);
                const newEndMin = newStartMin + (newHeightPx / PIXELS_PER_MINUTE);
                
                event.startTime = minutesToTime(Math.round(newStartMin / SNAP_MINS) * SNAP_MINS);
                event.endTime = minutesToTime(Math.round(newEndMin / SNAP_MINS) * SNAP_MINS);
                
                scheduleAutoSave();
                renderGrid();
            };
            
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
        
        handle.addEventListener('dragstart', (e) => { e.preventDefault(); });
    });
}

// =================================================================
// INIT
// =================================================================
function init() {
    container = document.getElementById("master-scheduler-content");
    if (!container) return;
    
    cleanupEventListeners();
    cleanupTabListeners();
    
    // Load data - first try draft, then default
    const hasDraft = loadDraftFromLocalStorage();
    if (!hasDraft) {
        loadDailySkeleton();
    }
    
    // Inject HTML
    container.innerHTML = `
        <div id="scheduler-template-ui"></div>
        <div id="scheduler-palette" class="ms-palette"></div>
        <div id="scheduler-grid-wrapper" class="ms-grid-wrapper">
            <div id="scheduler-grid"></div>
        </div>
        ${getStyles()}
    `;
    
    palette = document.getElementById("scheduler-palette");
    grid = document.getElementById("scheduler-grid");
    
    setupTabListeners();
    setupKeyboardShortcuts();
    
    _isInitialized = true;
    
    renderTemplateUI();
    renderPalette();
    renderGrid();
    
    console.log("[MASTER_SCHEDULER] Module v4.0 initialized");
}

function getStyles() {
    return `<style>
        /* Toast */
        .ms-toast { position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:#1f2937; color:white; padding:12px 24px; border-radius:8px; font-size:0.9rem; z-index:10003; opacity:0; transition:opacity 0.3s; pointer-events:none; }
        .ms-toast-show { opacity:1; }
        
        /* Template Bar */
        .ms-template-bar { background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:12px 16px; margin-bottom:16px; }
        .ms-template-status { margin-bottom:12px; font-size:0.9rem; }
        .ms-status-editing { color:#0369a1; }
        .ms-status-new { color:#059669; }
        .ms-draft-indicator { background:#fef3c7; color:#92400e; padding:2px 8px; border-radius:4px; font-size:0.8rem; margin-left:12px; }
        
        .ms-template-actions { display:flex; flex-wrap:wrap; gap:12px; align-items:center; }
        .ms-action-group { display:flex; gap:8px; align-items:center; }
        .ms-save-group { border-left:1px solid #e2e8f0; padding-left:12px; }
        .ms-delete-group { border-left:1px solid #e2e8f0; padding-left:12px; margin-left:auto; }
        
        .ms-select, .ms-input { padding:8px 12px; border:1px solid #d1d5db; border-radius:6px; font-size:0.9rem; }
        .ms-select:focus, .ms-input:focus { outline:none; border-color:#3b82f6; }
        .ms-select-sm, .ms-input-sm { padding:6px 10px; font-size:0.85rem; }
        
        .ms-btn { padding:8px 16px; border:none; border-radius:6px; font-size:0.9rem; font-weight:500; cursor:pointer; transition:all 0.15s; }
        .ms-btn-primary { background:#3b82f6; color:white; }
        .ms-btn-primary:hover { background:#2563eb; }
        .ms-btn-success { background:#10b981; color:white; }
        .ms-btn-success:hover { background:#059669; }
        .ms-btn-secondary { background:#e5e7eb; color:#374151; }
        .ms-btn-secondary:hover { background:#d1d5db; }
        .ms-btn-danger { background:#ef4444; color:white; }
        .ms-btn-danger:hover { background:#dc2626; }
        
        /* Palette */
        .ms-palette { display:flex; flex-wrap:wrap; gap:8px; padding:12px; background:#f4f4f4; border-radius:8px; margin-bottom:16px; }
        .ms-palette-tile { padding:8px 14px; border-radius:6px; cursor:grab; font-size:0.85rem; font-weight:500; user-select:none; }
        .ms-palette-tile:hover { filter:brightness(0.95); }
        
        /* Grid */
        .ms-grid-wrapper { overflow-x:auto; border:1px solid #d1d5db; border-radius:8px; background:#fff; }
        .ms-grid { display:grid; }
        .ms-grid-corner { background:#f1f5f9; border-bottom:1px solid #d1d5db; border-right:1px solid #d1d5db; }
        .ms-grid-header { color:#fff; padding:10px 8px; text-align:center; font-weight:600; font-size:0.9rem; border-bottom:1px solid #d1d5db; }
        
        .ms-time-column { position:relative; background:#f9fafb; border-right:1px solid #d1d5db; }
        .ms-time-marker { position:absolute; left:0; width:100%; border-top:1px dashed #e5e7eb; font-size:0.7rem; padding:2px 4px; color:#6b7280; }
        
        .ms-grid-cell { position:relative; border-right:1px solid #e5e7eb; background:#fff; }
        .ms-grid-cell:last-child { border-right:none; }
        .ms-cell-hover { background:#f0fdf4; }
        
        /* Disabled zones - dark grey with diagonal stripes */
        .ms-disabled-zone { position:absolute; width:100%; background-color:#9ca3af; background-image:repeating-linear-gradient(-45deg, transparent, transparent 4px, rgba(0,0,0,0.15) 4px, rgba(0,0,0,0.15) 8px); z-index:1; pointer-events:none; }
        
        /* Events */
        .ms-event { position:absolute; width:94%; left:3%; border-radius:4px; cursor:pointer; box-sizing:border-box; z-index:2; display:flex; flex-direction:column; justify-content:center; padding:4px 8px; overflow:hidden; box-shadow:0 1px 2px rgba(0,0,0,0.1); transition:box-shadow 0.15s; }
        .ms-event:hover { box-shadow:0 2px 8px rgba(0,0,0,0.15); }
        .ms-event.selected { box-shadow:0 0 0 2px #3b82f6; }
        .ms-event.resizing { z-index:100; box-shadow:0 0 0 2px #3b82f6, 0 4px 12px rgba(59,130,246,0.3); }
        .ms-event-small:hover { box-shadow:0 0 0 2px #ef4444; }
        
        .ms-event-content { display:flex; flex-direction:column; gap:2px; }
        .ms-tile-time { font-size:0.75em; opacity:0.8; }
        .ms-tile-fields { font-size:0.7em; opacity:0.7; }
        
        .ms-resize-handle { position:absolute; left:0; right:0; height:6px; cursor:ns-resize; opacity:0; transition:opacity 0.15s; }
        .ms-resize-top { top:0; }
        .ms-resize-bottom { bottom:0; }
        .ms-event:hover .ms-resize-handle { opacity:1; background:rgba(59,130,246,0.3); }
        
        .ms-drop-preview { display:none; position:absolute; left:3%; width:94%; background:rgba(59,130,246,0.1); border:2px dashed #3b82f6; border-radius:4px; pointer-events:none; z-index:5; }
        
        .ms-empty-message, .ms-error-message { padding:40px; text-align:center; color:#6b7280; }
        .ms-error-message { color:#dc2626; }
        
        /* Context Menu */
        .ms-context-menu { position:fixed; background:white; border-radius:6px; box-shadow:0 4px 16px rgba(0,0,0,0.15); overflow:hidden; min-width:120px; z-index:10005; }
        .ms-context-item { padding:10px 16px; cursor:pointer; font-size:0.9rem; color:#374151; }
        .ms-context-item:hover { background:#f3f4f6; }
        
        /* Modal */
        .ms-modal-overlay { position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); z-index:10004; display:flex; align-items:center; justify-content:center; }
        .ms-modal { background:white; border-radius:12px; width:90%; max-width:500px; max-height:90vh; overflow-y:auto; box-shadow:0 20px 60px rgba(0,0,0,0.3); }
        .ms-modal-sm { max-width:380px; }
        .ms-modal-header { display:flex; justify-content:space-between; align-items:center; padding:16px 20px; border-bottom:1px solid #e5e7eb; }
        .ms-modal-header h3 { margin:0; font-size:1.1rem; font-weight:600; }
        .ms-modal-close { background:none; border:none; font-size:1.5rem; cursor:pointer; color:#9ca3af; line-height:1; padding:0; }
        .ms-modal-close:hover { color:#374151; }
        .ms-modal-body { padding:20px; }
        .ms-modal-desc { color:#6b7280; font-size:0.9rem; margin:0 0 16px 0; }
        .ms-modal-footer { display:flex; justify-content:flex-end; gap:12px; padding:16px 20px; border-top:1px solid #e5e7eb; background:#f9fafb; }
        
        .ms-form-group { margin-bottom:16px; }
        .ms-form-row { display:flex; gap:12px; }
        .ms-form-half { flex:1; }
        .ms-label { display:block; font-size:0.85rem; font-weight:500; color:#374151; margin-bottom:6px; }
        
        /* Time Picker */
        .ms-time-picker { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
        .ms-time-section { display:flex; flex-direction:column; align-items:center; gap:4px; }
        .ms-time-label { font-size:0.75rem; color:#6b7280; text-transform:uppercase; }
        .ms-time-control { display:flex; align-items:center; gap:4px; }
        .ms-time-btn { width:32px; height:32px; border:1px solid #d1d5db; background:#fff; border-radius:6px; cursor:pointer; font-size:1.1rem; font-weight:600; color:#374151; }
        .ms-time-btn:hover { background:#f3f4f6; }
        .ms-time-input { width:90px; text-align:center; font-size:1rem; font-weight:500; padding:6px 8px; background:#fff; border:1px solid #d1d5db; border-radius:4px; }
        .ms-time-input:focus { outline:none; border-color:#3b82f6; box-shadow:0 0 0 2px rgba(59,130,246,0.2); }
        .ms-time-display { min-width:90px; text-align:center; font-size:1rem; font-weight:500; padding:6px 8px; background:#f3f4f6; border-radius:4px; }
        .ms-time-separator { color:#9ca3af; font-weight:500; }
        .ms-time-presets { display:flex; align-items:center; gap:6px; margin-top:8px; width:100%; }
        .ms-presets-label { font-size:0.8rem; color:#6b7280; margin-right:4px; }
        .ms-preset-btn { padding:6px 12px; border:1px solid #e5e7eb; background:#fff; border-radius:4px; font-size:0.8rem; cursor:pointer; }
        .ms-preset-btn:hover { background:#f3f4f6; border-color:#d1d5db; }
        .ms-preset-btn:active { background:#e5e7eb; }
        
        /* Checkbox Grid */
        .ms-checkbox-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); gap:8px; max-height:200px; overflow-y:auto; padding:8px; background:#f9fafb; border:1px solid #e5e7eb; border-radius:6px; }
        .ms-checkbox-item { display:flex; align-items:center; gap:6px; padding:4px 8px; background:#fff; border:1px solid #e5e7eb; border-radius:4px; cursor:pointer; font-size:0.85rem; }
        .ms-checkbox-item:hover { border-color:#d1d5db; }
        .ms-checkbox-item input { margin:0; }
        .ms-location-type { margin-left:auto; font-size:0.7rem; color:#9ca3af; }
    </style>`;
}

// =================================================================
// CLEANUP
// =================================================================
function cleanup() {
    cleanupEventListeners();
    cleanupTabListeners();
    removeContextMenu();
    
    ['master-scheduler-toast', 'tile-config-modal', 'tile-edit-modal'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.remove();
    });
    
    _isInitialized = false;
}

// =================================================================
// PUBLIC API
// =================================================================
window.initMasterScheduler = init;
window.cleanupMasterScheduler = cleanup;
window.refreshMasterSchedulerFromCloud = refreshFromStorage;
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
