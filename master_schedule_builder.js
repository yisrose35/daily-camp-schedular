// =================================================================
// master_schedule_builder.js (PREMIUM EDITION v5.0)
// =================================================================
// Complete UI overhaul - Enterprise-grade design system
// Inspired by Linear, Notion, Figma, and Apple design principles
// =================================================================

(function(){
'use strict';

console.log("[MASTER_SCHEDULER] Premium Edition v5.0 loading...");

// =================================================================
// STATE & CONFIGURATION
// =================================================================
let container = null;
let dailySkeleton = [];
let currentLoadedTemplate = null;
let _isInitialized = false;
let _refreshTimeout = null;
let _autoSaveTimeout = null;
let clipboardTile = null;
let lastHoveredCell = null;
let activeEventListeners = [];
let _visibilityHandler = null;
let _focusHandler = null;
let _keyboardHandler = null;

const SKELETON_DRAFT_KEY = 'master-schedule-draft';
const SKELETON_DRAFT_NAME_KEY = 'master-schedule-draft-name';
const PIXELS_PER_MINUTE = 2;
const SNAP_MINS = 5;
const AUTO_SAVE_DELAY = 1500;

// Premium color palette for tiles
const TILE_THEMES = {
    activity:        { bg: '#EEF2FF', border: '#6366F1', text: '#4338CA', accent: '#818CF8' },
    sports:          { bg: '#ECFDF5', border: '#10B981', text: '#047857', accent: '#34D399' },
    special:         { bg: '#F0FDF4', border: '#22C55E', text: '#15803D', accent: '#4ADE80' },
    smart:           { bg: '#EFF6FF', border: '#3B82F6', text: '#1D4ED8', accent: '#60A5FA', dashed: true },
    split:           { bg: '#FFF7ED', border: '#F97316', text: '#C2410C', accent: '#FB923C' },
    elective:        { bg: '#FAF5FF', border: '#A855F7', text: '#7E22CE', accent: '#C084FC' },
    league:          { bg: '#F5F3FF', border: '#8B5CF6', text: '#6D28D9', accent: '#A78BFA' },
    specialty_league:{ bg: '#FFFBEB', border: '#F59E0B', text: '#B45309', accent: '#FBBF24' },
    swim:            { bg: '#E0F2FE', border: '#0EA5E9', text: '#0369A1', accent: '#38BDF8' },
    lunch:           { bg: '#FEF2F2', border: '#EF4444', text: '#B91C1C', accent: '#F87171' },
    snacks:          { bg: '#FEFCE8', border: '#EAB308', text: '#A16207', accent: '#FACC15' },
    dismissal:       { bg: '#FEE2E2', border: '#DC2626', text: '#991B1B', accent: '#F87171' },
    custom:          { bg: '#F8FAFC', border: '#64748B', text: '#334155', accent: '#94A3B8' }
};

const TILES = [
    { type: 'activity', name: 'Activity', description: 'Flexible slot for sports or special activities' },
    { type: 'sports', name: 'Sports', description: 'Dedicated sports period' },
    { type: 'special', name: 'Special Activity', description: 'Special activity period' },
    { type: 'smart', name: 'Smart Tile', description: 'Balances two activities with fallback' },
    { type: 'split', name: 'Split Activity', description: 'Two activities share this block' },
    { type: 'elective', name: 'Elective', description: 'Multiple activity choices for division' },
    { type: 'league', name: 'League Game', description: 'Scheduled league game slot' },
    { type: 'specialty_league', name: 'Specialty League', description: 'Specialty league period' },
    { type: 'swim', name: 'Swim', description: 'Swimming period' },
    { type: 'lunch', name: 'Lunch', description: 'Lunch break' },
    { type: 'snacks', name: 'Snacks', description: 'Snack time' },
    { type: 'dismissal', name: 'Dismissal', description: 'End of day dismissal' },
    { type: 'custom', name: 'Custom Event', description: 'Custom scheduled event' }
];

// =================================================================
// UTILITY FUNCTIONS
// =================================================================
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function parseTimeToMinutes(str) {
    if (!str) return null;
    try {
        let s = str.toLowerCase().replace(/\s/g, '').replace(/am|pm/g, m => ' ' + m).trim();
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
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${m.toString().padStart(2, '0')} ${ap}`;
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function getCampTimeRange() {
    const divisions = window.divisions || {};
    const divNames = Object.keys(divisions).filter(d => divisions[d]?.bunks?.length > 0);
    
    let earliestMin = null;
    let latestMin = null;
    
    divNames.forEach(d => {
        const div = divisions[d];
        const s = parseTimeToMinutes(div?.startTime);
        const e = parseTimeToMinutes(div?.endTime);
        if (s !== null && (earliestMin === null || s < earliestMin)) earliestMin = s;
        if (e !== null && (latestMin === null || e > latestMin)) latestMin = e;
    });
    
    dailySkeleton.forEach(ev => {
        const s = parseTimeToMinutes(ev.startTime);
        const e = parseTimeToMinutes(ev.endTime);
        if (s !== null && (earliestMin === null || s < earliestMin)) earliestMin = s;
        if (e !== null && (latestMin === null || e > latestMin)) latestMin = e;
    });
    
    if (earliestMin === null) earliestMin = 540;
    if (latestMin === null) latestMin = 960;
    if (latestMin - earliestMin < 60) latestMin = earliestMin + 60;
    
    return { earliestMin, latestMin };
}

function getAllFieldsAndLocations() {
    const globalSettings = window.loadGlobalSettings?.() || {};
    const result = [];
    
    (globalSettings.app1?.fields || []).forEach(f => {
        if (f.available !== false) result.push({ name: f.name, type: 'Field' });
    });
    
    const zones = globalSettings.locationZones || {};
    Object.values(zones).forEach(zone => {
        if (zone.locations) {
            Object.keys(zone.locations).forEach(locName => {
                if (!result.find(x => x.name === locName)) {
                    result.push({ name: locName, type: zone.name || 'Location' });
                }
            });
        }
    });
    
    return result;
}

// =================================================================
// EVENT LISTENER MANAGEMENT
// =================================================================
function trackListener(type, handler, target = document) {
    activeEventListeners.push({ type, handler, target });
}

function cleanupListeners() {
    activeEventListeners.forEach(({ type, handler, target }) => {
        try { (target || document).removeEventListener(type, handler); } catch (e) {}
    });
    activeEventListeners = [];
    
    if (_visibilityHandler) document.removeEventListener('visibilitychange', _visibilityHandler);
    if (_focusHandler) window.removeEventListener('focus', _focusHandler);
    if (_keyboardHandler) document.removeEventListener('keydown', _keyboardHandler);
    
    clearTimeout(_refreshTimeout);
    clearTimeout(_autoSaveTimeout);
}

// =================================================================
// AUTO-SAVE & DRAFT MANAGEMENT
// =================================================================
function scheduleAutoSave() {
    clearTimeout(_autoSaveTimeout);
    _autoSaveTimeout = setTimeout(saveDraft, AUTO_SAVE_DELAY);
}

function saveDraft() {
    try {
        if (dailySkeleton?.length > 0) {
            localStorage.setItem(SKELETON_DRAFT_KEY, JSON.stringify(dailySkeleton));
            if (currentLoadedTemplate) localStorage.setItem(SKELETON_DRAFT_NAME_KEY, currentLoadedTemplate);
            else localStorage.removeItem(SKELETON_DRAFT_NAME_KEY);
        } else {
            localStorage.removeItem(SKELETON_DRAFT_KEY);
            localStorage.removeItem(SKELETON_DRAFT_NAME_KEY);
        }
        updateStatusIndicator();
    } catch (e) {}
}

function loadDraft() {
    try {
        const saved = localStorage.getItem(SKELETON_DRAFT_KEY);
        const savedName = localStorage.getItem(SKELETON_DRAFT_NAME_KEY);
        if (saved) {
            dailySkeleton = JSON.parse(saved);
            if (savedName) currentLoadedTemplate = savedName;
            return true;
        }
    } catch (e) {}
    return false;
}

function clearDraft() {
    localStorage.removeItem(SKELETON_DRAFT_KEY);
    localStorage.removeItem(SKELETON_DRAFT_NAME_KEY);
    updateStatusIndicator();
}

function updateStatusIndicator() {
    const indicator = document.getElementById('ms-status-indicator');
    if (!indicator) return;
    
    const hasChanges = dailySkeleton.length > 0;
    const isEditing = !!currentLoadedTemplate;
    
    if (isEditing) {
        indicator.innerHTML = `<span class="ms-status-badge ms-status-editing">Editing</span><span class="ms-status-name">${escapeHtml(currentLoadedTemplate)}</span>`;
    } else if (hasChanges) {
        indicator.innerHTML = `<span class="ms-status-badge ms-status-draft">Draft</span><span class="ms-status-name">Unsaved Schedule</span>`;
    } else {
        indicator.innerHTML = `<span class="ms-status-badge ms-status-new">New</span><span class="ms-status-name">Empty Schedule</span>`;
    }
}

// =================================================================
// CLOUD SYNC & TAB VISIBILITY
// =================================================================
function setupTabListeners() {
    _visibilityHandler = () => {
        if (document.visibilityState === 'visible' && _isInitialized) {
            clearTimeout(_refreshTimeout);
            _refreshTimeout = setTimeout(refreshTemplateList, 200);
        }
    };
    document.addEventListener('visibilitychange', _visibilityHandler);
    
    _focusHandler = () => {
        if (_isInitialized) {
            clearTimeout(_refreshTimeout);
            _refreshTimeout = setTimeout(refreshTemplateList, 250);
        }
    };
    window.addEventListener('focus', _focusHandler);
}

function refreshTemplateList() {
    const select = document.getElementById('ms-template-select');
    if (!select) return;
    
    const saved = window.getSavedSkeletons?.() || {};
    const names = Object.keys(saved).sort();
    const currentVal = select.value;
    
    select.innerHTML = `<option value="">Select template...</option>` + 
        names.map(n => `<option value="${escapeHtml(n)}" ${n === currentVal ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('');
}

// =================================================================
// KEYBOARD SHORTCUTS
// =================================================================
function setupKeyboardShortcuts() {
    _keyboardHandler = (e) => {
        const tab = document.getElementById('master-scheduler');
        if (!tab || !tab.classList.contains('active')) return;
        
        const grid = document.getElementById('ms-grid');
        const selected = grid?.querySelector('.ms-tile.selected');
        
        if ((e.ctrlKey || e.metaKey) && e.key === 'c' && selected) {
            const ev = dailySkeleton.find(x => x.id === selected.dataset.id);
            if (ev) { clipboardTile = { ...ev, id: null }; showToast('Copied to clipboard'); }
            e.preventDefault();
        }
        
        if ((e.ctrlKey || e.metaKey) && e.key === 'v' && clipboardTile && lastHoveredCell) {
            pasteTile(lastHoveredCell);
            showToast('Pasted from clipboard');
            e.preventDefault();
        }
        
        if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !e.target.matches('input, textarea, select')) {
            const id = selected.dataset.id;
            if (id) {
                dailySkeleton = dailySkeleton.filter(x => x.id !== id);
                scheduleAutoSave();
                renderGrid();
            }
            e.preventDefault();
        }
    };
    document.addEventListener('keydown', _keyboardHandler);
}

function pasteTile(cell) {
    if (!clipboardTile || !cell) return;
    
    const divName = cell.dataset.div;
    const { earliestMin } = getCampTimeRange();
    const cellTop = parseInt(cell.dataset.startMin, 10) || earliestMin;
    
    const origStart = parseTimeToMinutes(clipboardTile.startTime);
    const origEnd = parseTimeToMinutes(clipboardTile.endTime);
    const duration = (origStart !== null && origEnd !== null) ? (origEnd - origStart) : 30;
    
    dailySkeleton.push({
        ...clipboardTile,
        id: generateId(),
        division: divName,
        startTime: minutesToTime(cellTop),
        endTime: minutesToTime(cellTop + duration)
    });
    
    scheduleAutoSave();
    renderGrid();
}

// =================================================================
// TOAST NOTIFICATIONS
// =================================================================
function showToast(message) {
    let toast = document.getElementById('ms-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'ms-toast';
        toast.className = 'ms-toast';
        document.body.appendChild(toast);
    }
    
    toast.textContent = message;
    toast.classList.add('visible');
    
    setTimeout(() => toast.classList.remove('visible'), 2500);
}

// =================================================================
// LOAD & SAVE TEMPLATES
// =================================================================
function loadDefaultSkeleton() {
    try {
        const assignments = window.getSkeletonAssignments?.() || {};
        const skeletons = window.getSavedSkeletons?.() || {};
        const dateStr = window.currentScheduleDate || "";
        const [Y, M, D] = dateStr.split('-').map(Number);
        let dow = 0;
        if (Y && M && D) dow = new Date(Y, M - 1, D).getDay();
        const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        const tmpl = assignments[dayNames[dow]] || assignments["Default"];
        dailySkeleton = (tmpl && skeletons[tmpl]) ? JSON.parse(JSON.stringify(skeletons[tmpl])) : [];
    } catch (e) {
        dailySkeleton = [];
    }
}

function loadTemplate(name) {
    const all = window.getSavedSkeletons?.() || {};
    if (!all[name]) return;
    
    dailySkeleton = JSON.parse(JSON.stringify(all[name]));
    currentLoadedTemplate = name;
    clearDraft();
    renderGrid();
    updateStatusIndicator();
    showToast(`Loaded "${name}"`);
}

function saveTemplate(name, isUpdate = false) {
    if (!name) return;
    if (!window.AccessControl?.checkSetupAccess?.(isUpdate ? 'update schedule templates' : 'save schedule templates')) return;
    
    window.saveSkeleton?.(name, dailySkeleton);
    window.forceSyncToCloud?.();
    currentLoadedTemplate = name;
    clearDraft();
    refreshTemplateList();
    updateStatusIndicator();
    showToast(isUpdate ? `Updated "${name}"` : `Saved "${name}"`);
}

function deleteTemplate(name) {
    if (!name) return;
    if (!window.AccessControl?.checkSetupAccess?.('delete schedule templates')) return;
    
    window.deleteSkeleton?.(name);
    window.forceSyncToCloud?.();
    
    if (currentLoadedTemplate === name) {
        currentLoadedTemplate = null;
        dailySkeleton = [];
        clearDraft();
        renderGrid();
    }
    
    refreshTemplateList();
    updateStatusIndicator();
    showToast(`Deleted "${name}"`);
}

// =================================================================
// TILE CONFIGURATION MODAL
// =================================================================
function showTileModal(tileType, division, startMin, existingEvent = null) {
    const tile = TILES.find(t => t.type === tileType);
    const theme = TILE_THEMES[tileType] || TILE_THEMES.custom;
    if (!tile) return;
    
    const { earliestMin, latestMin } = getCampTimeRange();
    const locations = getAllFieldsAndLocations();
    
    let currentStart = existingEvent ? parseTimeToMinutes(existingEvent.startTime) : (startMin || earliestMin);
    let currentEnd = existingEvent ? parseTimeToMinutes(existingEvent.endTime) : (currentStart + 30);
    
    const modal = document.createElement('div');
    modal.id = 'ms-modal';
    modal.className = 'ms-modal-overlay';
    
    // Build type-specific fields
    let typeFields = '';
    
    if (tileType === 'custom') {
        typeFields = `
            <div class="ms-field">
                <label>Event Name</label>
                <input type="text" id="modal-event-name" class="ms-input-lg" placeholder="Enter event name..." value="${escapeHtml(existingEvent?.event || '')}">
            </div>
        `;
    } else if (tileType === 'smart') {
        typeFields = `
            <div class="ms-field-row">
                <div class="ms-field">
                    <label>Activity 1</label>
                    <input type="text" id="modal-act1" placeholder="e.g., Swim" value="${escapeHtml(existingEvent?.smartData?.activity1 || '')}">
                </div>
                <div class="ms-field">
                    <label>Activity 2</label>
                    <input type="text" id="modal-act2" placeholder="e.g., Art" value="${escapeHtml(existingEvent?.smartData?.activity2 || '')}">
                </div>
            </div>
            <div class="ms-field-row">
                <div class="ms-field">
                    <label>Fallback For</label>
                    <select id="modal-fallback-for">
                        <option value="1">Activity 1</option>
                        <option value="2">Activity 2</option>
                    </select>
                </div>
                <div class="ms-field">
                    <label>Fallback Activity</label>
                    <input type="text" id="modal-fallback" placeholder="e.g., Gaga" value="${escapeHtml(existingEvent?.smartData?.fallbackActivity || '')}">
                </div>
            </div>
        `;
    } else if (tileType === 'split') {
        typeFields = `
            <div class="ms-field-row">
                <div class="ms-field">
                    <label>First Activity</label>
                    <input type="text" id="modal-split1" placeholder="First half" value="${escapeHtml(existingEvent?.subEvents?.[0]?.activity || '')}">
                </div>
                <div class="ms-field">
                    <label>Second Activity</label>
                    <input type="text" id="modal-split2" placeholder="Second half" value="${escapeHtml(existingEvent?.subEvents?.[1]?.activity || '')}">
                </div>
            </div>
        `;
    } else if (tileType === 'elective') {
        const activities = [
            ...(window.loadGlobalSettings?.()?.app1?.fields || []).filter(f => f.available !== false).map(f => f.name),
            ...(window.loadGlobalSettings?.()?.app1?.specialActivities || []).filter(s => s.available !== false).map(s => s.name)
        ];
        const selected = existingEvent?.electiveActivities || [];
        
        typeFields = `
            <div class="ms-field">
                <label>Select Activities (2 or more)</label>
                <div class="ms-checkbox-list">
                    ${activities.map(a => `
                        <label class="ms-checkbox-item">
                            <input type="checkbox" name="elective-act" value="${escapeHtml(a)}" ${selected.includes(a) ? 'checked' : ''}>
                            <span>${escapeHtml(a)}</span>
                        </label>
                    `).join('')}
                </div>
            </div>
        `;
    }
    
    // Location selection (custom only)
    let locationFields = '';
    if (tileType === 'custom' && locations.length > 0) {
        const reserved = existingEvent?.reservedFields || [];
        locationFields = `
            <div class="ms-field">
                <label>Reserve Locations</label>
                <div class="ms-checkbox-list">
                    ${locations.map(loc => `
                        <label class="ms-checkbox-item">
                            <input type="checkbox" name="reserved-loc" value="${escapeHtml(loc.name)}" ${reserved.includes(loc.name) ? 'checked' : ''}>
                            <span>${escapeHtml(loc.name)}</span>
                            <span class="ms-checkbox-meta">${escapeHtml(loc.type)}</span>
                        </label>
                    `).join('')}
                </div>
            </div>
        `;
    }
    
    modal.innerHTML = `
        <div class="ms-modal" style="--modal-accent: ${theme.border}; --modal-bg: ${theme.bg};">
            <div class="ms-modal-header">
                <div class="ms-modal-icon" style="background: ${theme.bg}; border-color: ${theme.border}; color: ${theme.text};">
                    ${tile.name.charAt(0)}
                </div>
                <div class="ms-modal-title">
                    <h2>${existingEvent ? 'Edit' : 'Add'} ${escapeHtml(tile.name)}</h2>
                    <p>${escapeHtml(tile.description)}</p>
                </div>
                <button class="ms-modal-close" id="modal-close">
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M15 5L5 15M5 5l10 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                </button>
            </div>
            
            <div class="ms-modal-body">
                ${typeFields}
                
                <div class="ms-field">
                    <label>Time</label>
                    <div class="ms-time-picker">
                        <div class="ms-time-group">
                            <span class="ms-time-label">Start</span>
                            <div class="ms-time-control">
                                <button type="button" class="ms-time-btn" data-action="start-down">
                                    <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 4l4 4 4-4" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
                                </button>
                                <input type="text" id="modal-start" class="ms-time-value" value="${minutesToTime(currentStart)}">
                                <button type="button" class="ms-time-btn" data-action="start-up">
                                    <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 8l4-4 4 4" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
                                </button>
                            </div>
                        </div>
                        <div class="ms-time-divider"></div>
                        <div class="ms-time-group">
                            <span class="ms-time-label">End</span>
                            <div class="ms-time-control">
                                <button type="button" class="ms-time-btn" data-action="end-down">
                                    <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 4l4 4 4-4" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
                                </button>
                                <input type="text" id="modal-end" class="ms-time-value" value="${minutesToTime(currentEnd)}">
                                <button type="button" class="ms-time-btn" data-action="end-up">
                                    <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 8l4-4 4 4" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
                                </button>
                            </div>
                        </div>
                    </div>
                    <div class="ms-duration-presets">
                        <span>Quick:</span>
                        <button type="button" data-mins="15">15m</button>
                        <button type="button" data-mins="30">30m</button>
                        <button type="button" data-mins="45">45m</button>
                        <button type="button" data-mins="60">1h</button>
                        <button type="button" data-mins="90">1.5h</button>
                    </div>
                </div>
                
                ${locationFields}
            </div>
            
            <div class="ms-modal-footer">
                <button class="ms-btn ms-btn-ghost" id="modal-cancel">Cancel</button>
                <button class="ms-btn ms-btn-primary" id="modal-confirm" style="background: ${theme.border};">
                    ${existingEvent ? 'Save Changes' : 'Add to Schedule'}
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Time control logic
    const startInput = document.getElementById('modal-start');
    const endInput = document.getElementById('modal-end');
    
    const updateTimes = () => {
        startInput.value = minutesToTime(currentStart);
        endInput.value = minutesToTime(currentEnd);
    };
    
    startInput.addEventListener('blur', () => {
        const p = parseTimeToMinutes(startInput.value);
        if (p !== null) { currentStart = p; if (currentStart >= currentEnd) currentEnd = currentStart + 30; }
        updateTimes();
    });
    
    endInput.addEventListener('blur', () => {
        const p = parseTimeToMinutes(endInput.value);
        if (p !== null && p > currentStart) currentEnd = p;
        updateTimes();
    });
    
    modal.querySelectorAll('.ms-time-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const action = btn.dataset.action;
            if (action === 'start-up') currentStart = Math.min(currentStart + 5, currentEnd - 5);
            else if (action === 'start-down') currentStart = Math.max(currentStart - 5, 0);
            else if (action === 'end-up') currentEnd = Math.min(currentEnd + 5, 1440);
            else if (action === 'end-down') currentEnd = Math.max(currentEnd - 5, currentStart + 5);
            updateTimes();
        });
    });
    
    modal.querySelectorAll('.ms-duration-presets button').forEach(btn => {
        btn.addEventListener('click', () => {
            currentEnd = currentStart + parseInt(btn.dataset.mins, 10);
            updateTimes();
        });
    });
    
    // Close handlers
    const closeModal = () => modal.remove();
    modal.querySelector('#modal-close').addEventListener('click', closeModal);
    modal.querySelector('#modal-cancel').addEventListener('click', closeModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
    
    // Confirm handler
    modal.querySelector('#modal-confirm').addEventListener('click', () => {
        const event = existingEvent ? { ...existingEvent } : {
            id: generateId(),
            type: tileType,
            event: tile.name,
            division: division,
            reservedFields: []
        };
        
        event.startTime = minutesToTime(currentStart);
        event.endTime = minutesToTime(currentEnd);
        
        // Type-specific data
        if (tileType === 'custom') {
            const name = modal.querySelector('#modal-event-name')?.value.trim();
            if (!name) { alert('Please enter an event name.'); return; }
            event.event = name;
            event.reservedFields = Array.from(modal.querySelectorAll('input[name="reserved-loc"]:checked')).map(cb => cb.value);
        } else if (tileType === 'smart') {
            const a1 = modal.querySelector('#modal-act1')?.value.trim();
            const a2 = modal.querySelector('#modal-act2')?.value.trim();
            const fb = modal.querySelector('#modal-fallback')?.value.trim();
            if (!a1 || !a2 || !fb) { alert('Please fill in all fields.'); return; }
            event.smartData = { activity1: a1, activity2: a2, fallbackFor: modal.querySelector('#modal-fallback-for').value === '1' ? a1 : a2, fallbackActivity: fb };
        } else if (tileType === 'split') {
            const s1 = modal.querySelector('#modal-split1')?.value.trim();
            const s2 = modal.querySelector('#modal-split2')?.value.trim();
            if (!s1 || !s2) { alert('Please fill in both activities.'); return; }
            const mid = currentStart + Math.floor((currentEnd - currentStart) / 2);
            event.subEvents = [
                { activity: s1, startTime: minutesToTime(currentStart), endTime: minutesToTime(mid) },
                { activity: s2, startTime: minutesToTime(mid), endTime: minutesToTime(currentEnd) }
            ];
        } else if (tileType === 'elective') {
            const acts = Array.from(modal.querySelectorAll('input[name="elective-act"]:checked')).map(cb => cb.value);
            if (acts.length < 2) { alert('Please select at least 2 activities.'); return; }
            event.electiveActivities = acts;
        }
        
        if (existingEvent) {
            const idx = dailySkeleton.findIndex(e => e.id === existingEvent.id);
            if (idx !== -1) dailySkeleton[idx] = event;
        } else {
            dailySkeleton.push(event);
        }
        
        closeModal();
        scheduleAutoSave();
        renderGrid();
    });
    
    // Focus first input
    setTimeout(() => {
        const firstInput = modal.querySelector('input:not([type="checkbox"])');
        if (firstInput) firstInput.focus();
    }, 100);
}

// =================================================================
// RENDER FUNCTIONS
// =================================================================
function render() {
    if (!container) return;
    
    container.innerHTML = `
        <div class="ms-container">
            ${renderHeader()}
            ${renderToolbar()}
            ${renderPalette()}
            <div class="ms-grid-container">
                <div id="ms-grid" class="ms-grid"></div>
            </div>
        </div>
        ${getStyles()}
    `;
    
    bindHeaderEvents();
    renderGrid();
    updateStatusIndicator();
}

function renderHeader() {
    return `
        <div class="ms-header">
            <div class="ms-header-left">
                <h1 class="ms-title">Schedule Builder</h1>
                <div id="ms-status-indicator" class="ms-status"></div>
            </div>
            <div class="ms-header-right">
                <div class="ms-template-controls">
                    <select id="ms-template-select" class="ms-select">
                        <option value="">Select template...</option>
                    </select>
                    <button id="ms-btn-load" class="ms-btn ms-btn-ghost">Load</button>
                </div>
            </div>
        </div>
    `;
}

function renderToolbar() {
    return `
        <div class="ms-toolbar">
            <div class="ms-toolbar-left">
                <button id="ms-btn-clear" class="ms-btn ms-btn-ghost">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M5.333 4V2.667a1.333 1.333 0 011.334-1.334h2.666a1.333 1.333 0 011.334 1.334V4m2 0v9.333a1.333 1.333 0 01-1.334 1.334H4.667a1.333 1.333 0 01-1.334-1.334V4h9.334z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    Clear
                </button>
            </div>
            <div class="ms-toolbar-right">
                <div class="ms-save-group">
                    <input type="text" id="ms-save-name" class="ms-input" placeholder="Template name...">
                    <button id="ms-btn-save" class="ms-btn ms-btn-secondary">Save New</button>
                </div>
                <button id="ms-btn-update" class="ms-btn ms-btn-primary" style="display:none;">Update Template</button>
                <div class="ms-delete-group">
                    <select id="ms-delete-select" class="ms-select ms-select-sm">
                        <option value="">Delete...</option>
                    </select>
                    <button id="ms-btn-delete" class="ms-btn ms-btn-danger">Delete</button>
                </div>
            </div>
        </div>
    `;
}

function renderPalette() {
    return `
        <div class="ms-palette">
            <div class="ms-palette-label">Drag to add:</div>
            <div class="ms-palette-tiles">
                ${TILES.map(tile => {
                    const theme = TILE_THEMES[tile.type];
                    return `
                        <div class="ms-palette-tile" draggable="true" data-type="${tile.type}" 
                             style="background: ${theme.bg}; border-color: ${theme.border}; color: ${theme.text}; ${theme.dashed ? 'border-style: dashed;' : ''}"
                             title="${tile.description}">
                            ${tile.name}
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
}

function renderGrid() {
    const grid = document.getElementById('ms-grid');
    if (!grid) return;
    
    const divisions = window.divisions || {};
    const availableDivs = Object.keys(divisions).filter(d => divisions[d]?.bunks?.length > 0);
    
    if (availableDivs.length === 0) {
        grid.innerHTML = `<div class="ms-empty-state"><div class="ms-empty-icon">📅</div><h3>No Divisions Available</h3><p>Please configure divisions with bunks in the Setup tab first.</p></div>`;
        return;
    }
    
    const { earliestMin, latestMin } = getCampTimeRange();
    const totalHeight = (latestMin - earliestMin) * PIXELS_PER_MINUTE;
    
    let html = `<div class="ms-grid-inner" style="grid-template-columns: 72px repeat(${availableDivs.length}, 1fr);">`;
    
    // Header row
    html += `<div class="ms-grid-corner"></div>`;
    availableDivs.forEach(d => {
        const color = divisions[d]?.color || '#6366F1';
        html += `<div class="ms-grid-header" style="--div-color: ${color};">${escapeHtml(d)}</div>`;
    });
    
    // Time column
    html += `<div class="ms-time-col" style="height: ${totalHeight}px;">`;
    for (let m = earliestMin; m < latestMin; m += 30) {
        const top = (m - earliestMin) * PIXELS_PER_MINUTE;
        const isHour = m % 60 === 0;
        html += `<div class="ms-time-mark ${isHour ? 'ms-time-hour' : ''}" style="top: ${top}px;">${minutesToTime(m)}</div>`;
    }
    html += `</div>`;
    
    // Division columns
    availableDivs.forEach(d => {
        const div = divisions[d];
        const divStart = parseTimeToMinutes(div?.startTime);
        const divEnd = parseTimeToMinutes(div?.endTime);
        
        html += `<div class="ms-grid-col" data-div="${escapeHtml(d)}" data-start-min="${earliestMin}" style="height: ${totalHeight}px;">`;
        
        // Disabled zones
        if (divStart !== null && divStart > earliestMin) {
            html += `<div class="ms-disabled-zone" style="top: 0; height: ${(divStart - earliestMin) * PIXELS_PER_MINUTE}px;"></div>`;
        }
        if (divEnd !== null && divEnd < latestMin) {
            html += `<div class="ms-disabled-zone" style="top: ${(divEnd - earliestMin) * PIXELS_PER_MINUTE}px; height: ${(latestMin - divEnd) * PIXELS_PER_MINUTE}px;"></div>`;
        }
        
        // Hour lines
        for (let m = earliestMin; m < latestMin; m += 60) {
            const top = (m - earliestMin) * PIXELS_PER_MINUTE;
            html += `<div class="ms-hour-line" style="top: ${top}px;"></div>`;
        }
        
        // Events
        dailySkeleton.filter(ev => ev.division === d).forEach(ev => {
            const start = parseTimeToMinutes(ev.startTime);
            const end = parseTimeToMinutes(ev.endTime);
            if (start !== null && end !== null && end > start) {
                const top = (start - earliestMin) * PIXELS_PER_MINUTE;
                const height = (end - start) * PIXELS_PER_MINUTE;
                html += renderTile(ev, top, height);
            }
        });
        
        html += `</div>`;
    });
    
    html += `</div>`;
    grid.innerHTML = html;
    
    bindGridEvents();
    bindPaletteEvents();
}

function renderTile(ev, top, height) {
    const theme = TILE_THEMES[ev.type] || TILE_THEMES.custom;
    const isSmall = height < 50;
    const displayName = ev.event || TILES.find(t => t.type === ev.type)?.name || 'Event';
    
    return `
        <div class="ms-tile ${isSmall ? 'ms-tile-sm' : ''}" data-id="${ev.id}" draggable="true"
             style="top: ${top}px; height: ${height}px; background: ${theme.bg}; border-color: ${theme.border}; color: ${theme.text}; ${theme.dashed ? 'border-style: dashed;' : ''}">
            ${!isSmall ? '<div class="ms-tile-resize ms-tile-resize-top"></div>' : ''}
            <div class="ms-tile-content">
                <span class="ms-tile-name">${escapeHtml(displayName)}</span>
                ${!isSmall ? `<span class="ms-tile-time">${ev.startTime} - ${ev.endTime}</span>` : ''}
            </div>
            ${!isSmall ? '<div class="ms-tile-resize ms-tile-resize-bottom"></div>' : ''}
        </div>
    `;
}

// =================================================================
// EVENT BINDINGS
// =================================================================
function bindHeaderEvents() {
    refreshTemplateList();
    
    // Populate delete select
    const deleteSelect = document.getElementById('ms-delete-select');
    const saved = window.getSavedSkeletons?.() || {};
    deleteSelect.innerHTML = `<option value="">Delete...</option>` + 
        Object.keys(saved).sort().map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
    
    // Load button
    document.getElementById('ms-btn-load')?.addEventListener('click', () => {
        const name = document.getElementById('ms-template-select').value;
        if (!name) { showToast('Select a template first'); return; }
        if (dailySkeleton.length > 0 && !confirm(`Load "${name}"? Current changes will be lost.`)) return;
        loadTemplate(name);
    });
    
    // Clear button
    document.getElementById('ms-btn-clear')?.addEventListener('click', () => {
        if (dailySkeleton.length > 0 && !confirm('Clear the entire schedule?')) return;
        dailySkeleton = [];
        currentLoadedTemplate = null;
        clearDraft();
        renderGrid();
        updateStatusIndicator();
    });
    
    // Save button
    document.getElementById('ms-btn-save')?.addEventListener('click', () => {
        const name = document.getElementById('ms-save-name').value.trim();
        if (!name) { showToast('Enter a template name'); return; }
        const existing = window.getSavedSkeletons?.() || {};
        if (existing[name] && !confirm(`"${name}" exists. Overwrite?`)) return;
        saveTemplate(name, false);
        document.getElementById('ms-save-name').value = '';
    });
    
    // Update button
    const updateBtn = document.getElementById('ms-btn-update');
    if (currentLoadedTemplate) {
        updateBtn.style.display = 'block';
        updateBtn.addEventListener('click', () => saveTemplate(currentLoadedTemplate, true));
    }
    
    // Delete button
    document.getElementById('ms-btn-delete')?.addEventListener('click', () => {
        const name = document.getElementById('ms-delete-select').value;
        if (!name) { showToast('Select a template to delete'); return; }
        if (!confirm(`Permanently delete "${name}"?`)) return;
        deleteTemplate(name);
    });
}

function bindPaletteEvents() {
    document.querySelectorAll('.ms-palette-tile').forEach(tile => {
        tile.addEventListener('dragstart', e => {
            e.dataTransfer.setData('text/tile-type', tile.dataset.type);
            tile.classList.add('dragging');
        });
        tile.addEventListener('dragend', () => tile.classList.remove('dragging'));
    });
}

function bindGridEvents() {
    const grid = document.getElementById('ms-grid');
    if (!grid) return;
    
    // Column drop handlers
    grid.querySelectorAll('.ms-grid-col').forEach(col => {
        col.addEventListener('mouseenter', () => { lastHoveredCell = col; });
        
        col.addEventListener('dragover', e => {
            e.preventDefault();
            col.classList.add('ms-col-hover');
        });
        
        col.addEventListener('dragleave', e => {
            if (!col.contains(e.relatedTarget)) col.classList.remove('ms-col-hover');
        });
        
        col.addEventListener('drop', e => {
            e.preventDefault();
            col.classList.remove('ms-col-hover');
            
            // Move existing tile
            const moveId = e.dataTransfer.getData('text/tile-move');
            if (moveId) {
                const ev = dailySkeleton.find(x => x.id === moveId);
                if (ev) {
                    const { earliestMin } = getCampTimeRange();
                    const rect = col.getBoundingClientRect();
                    const y = e.clientY - rect.top;
                    const newStart = earliestMin + Math.round(y / PIXELS_PER_MINUTE / SNAP_MINS) * SNAP_MINS;
                    const duration = parseTimeToMinutes(ev.endTime) - parseTimeToMinutes(ev.startTime);
                    
                    ev.division = col.dataset.div;
                    ev.startTime = minutesToTime(newStart);
                    ev.endTime = minutesToTime(newStart + duration);
                    
                    scheduleAutoSave();
                    renderGrid();
                }
                return;
            }
            
            // New tile from palette
            const tileType = e.dataTransfer.getData('text/tile-type');
            if (tileType) {
                const { earliestMin } = getCampTimeRange();
                const rect = col.getBoundingClientRect();
                const y = e.clientY - rect.top;
                const startMin = earliestMin + Math.round(y / PIXELS_PER_MINUTE / 15) * 15;
                
                showTileModal(tileType, col.dataset.div, startMin);
            }
        });
    });
    
    // Tile handlers
    grid.querySelectorAll('.ms-tile').forEach(tile => {
        const id = tile.dataset.id;
        const ev = dailySkeleton.find(x => x.id === id);
        
        tile.addEventListener('click', e => {
            if (e.target.classList.contains('ms-tile-resize')) return;
            grid.querySelectorAll('.ms-tile.selected').forEach(t => t.classList.remove('selected'));
            tile.classList.add('selected');
        });
        
        tile.addEventListener('dblclick', e => {
            if (e.target.classList.contains('ms-tile-resize')) return;
            if (ev) showTileModal(ev.type, ev.division, null, ev);
        });
        
        tile.addEventListener('contextmenu', e => {
            e.preventDefault();
            if (confirm('Delete this tile?')) {
                dailySkeleton = dailySkeleton.filter(x => x.id !== id);
                scheduleAutoSave();
                renderGrid();
            }
        });
        
        tile.addEventListener('dragstart', e => {
            if (e.target.classList.contains('ms-tile-resize')) { e.preventDefault(); return; }
            e.dataTransfer.setData('text/tile-move', id);
            tile.style.opacity = '0.5';
        });
        
        tile.addEventListener('dragend', () => { tile.style.opacity = '1'; });
        
        // Resize handles
        tile.querySelectorAll('.ms-tile-resize').forEach(handle => {
            const isTop = handle.classList.contains('ms-tile-resize-top');
            let startY, startTop, startHeight;
            
            const onMouseDown = e => {
                e.preventDefault();
                e.stopPropagation();
                startY = e.clientY;
                startTop = parseInt(tile.style.top, 10);
                startHeight = parseInt(tile.style.height, 10);
                tile.classList.add('resizing');
                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            };
            
            const onMouseMove = e => {
                const delta = e.clientY - startY;
                if (isTop) {
                    const newTop = Math.round((startTop + delta) / (SNAP_MINS * PIXELS_PER_MINUTE)) * (SNAP_MINS * PIXELS_PER_MINUTE);
                    const newHeight = startHeight - (newTop - startTop);
                    if (newHeight >= 20) {
                        tile.style.top = newTop + 'px';
                        tile.style.height = newHeight + 'px';
                    }
                } else {
                    const newHeight = Math.max(20, Math.round((startHeight + delta) / (SNAP_MINS * PIXELS_PER_MINUTE)) * (SNAP_MINS * PIXELS_PER_MINUTE));
                    tile.style.height = newHeight + 'px';
                }
            };
            
            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                tile.classList.remove('resizing');
                
                if (ev) {
                    const { earliestMin } = getCampTimeRange();
                    const newTop = parseInt(tile.style.top, 10);
                    const newHeight = parseInt(tile.style.height, 10);
                    ev.startTime = minutesToTime(earliestMin + newTop / PIXELS_PER_MINUTE);
                    ev.endTime = minutesToTime(earliestMin + (newTop + newHeight) / PIXELS_PER_MINUTE);
                    scheduleAutoSave();
                    renderGrid();
                }
            };
            
            handle.addEventListener('mousedown', onMouseDown);
        });
    });
    
    // Deselect on click outside
    grid.addEventListener('click', e => {
        if (!e.target.closest('.ms-tile')) {
            grid.querySelectorAll('.ms-tile.selected').forEach(t => t.classList.remove('selected'));
        }
    });
}

// =================================================================
// PREMIUM STYLES
// =================================================================
function getStyles() {
    return `<style>
/* =================================================================
   MASTER SCHEDULER - PREMIUM DESIGN SYSTEM v5.0
   Enterprise-grade UI inspired by Linear, Notion, Figma
   ================================================================= */

.ms-container {
    --ms-font: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', Roboto, sans-serif;
    --ms-bg: #FFFFFF;
    --ms-bg-subtle: #F9FAFB;
    --ms-bg-muted: #F3F4F6;
    --ms-border: #E5E7EB;
    --ms-border-strong: #D1D5DB;
    --ms-text: #111827;
    --ms-text-secondary: #6B7280;
    --ms-text-muted: #9CA3AF;
    --ms-primary: #6366F1;
    --ms-primary-hover: #4F46E5;
    --ms-danger: #EF4444;
    --ms-success: #10B981;
    --ms-radius-sm: 6px;
    --ms-radius-md: 8px;
    --ms-radius-lg: 12px;
    --ms-shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
    --ms-shadow-md: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06);
    --ms-shadow-lg: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -2px rgba(0,0,0,0.05);
    --ms-shadow-xl: 0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04);
    --ms-transition: 150ms cubic-bezier(0.4, 0, 0.2, 1);
    
    font-family: var(--ms-font);
    color: var(--ms-text);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
}

/* =================================================================
   HEADER
   ================================================================= */
.ms-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 20px 0;
    border-bottom: 1px solid var(--ms-border);
    margin-bottom: 20px;
}

.ms-header-left {
    display: flex;
    align-items: center;
    gap: 16px;
}

.ms-title {
    font-size: 24px;
    font-weight: 700;
    letter-spacing: -0.025em;
    margin: 0;
    background: linear-gradient(135deg, var(--ms-text) 0%, var(--ms-text-secondary) 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
}

.ms-status {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
}

.ms-status-badge {
    padding: 4px 10px;
    border-radius: 20px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
}

.ms-status-new { background: var(--ms-bg-muted); color: var(--ms-text-muted); }
.ms-status-draft { background: #FEF3C7; color: #92400E; }
.ms-status-editing { background: #DBEAFE; color: #1E40AF; }

.ms-status-name {
    font-weight: 500;
    color: var(--ms-text-secondary);
}

.ms-template-controls {
    display: flex;
    align-items: center;
    gap: 8px;
}

/* =================================================================
   TOOLBAR
   ================================================================= */
.ms-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    background: var(--ms-bg-subtle);
    border: 1px solid var(--ms-border);
    border-radius: var(--ms-radius-lg);
    margin-bottom: 20px;
}

.ms-toolbar-left, .ms-toolbar-right {
    display: flex;
    align-items: center;
    gap: 12px;
}

.ms-save-group, .ms-delete-group {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-left: 12px;
    border-left: 1px solid var(--ms-border);
}

/* =================================================================
   FORM CONTROLS
   ================================================================= */
.ms-input, .ms-select {
    height: 36px;
    padding: 0 12px;
    font-size: 14px;
    font-family: var(--ms-font);
    color: var(--ms-text);
    background: var(--ms-bg);
    border: 1px solid var(--ms-border-strong);
    border-radius: var(--ms-radius-sm);
    transition: all var(--ms-transition);
}

.ms-input:focus, .ms-select:focus {
    outline: none;
    border-color: var(--ms-primary);
    box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
}

.ms-input::placeholder { color: var(--ms-text-muted); }

.ms-select { cursor: pointer; padding-right: 32px; }
.ms-select-sm { height: 32px; font-size: 13px; }

/* =================================================================
   BUTTONS
   ================================================================= */
.ms-btn {
    height: 36px;
    padding: 0 16px;
    font-size: 14px;
    font-weight: 500;
    font-family: var(--ms-font);
    border: none;
    border-radius: var(--ms-radius-sm);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: all var(--ms-transition);
    white-space: nowrap;
}

.ms-btn:active { transform: scale(0.98); }

.ms-btn-primary {
    background: var(--ms-primary);
    color: white;
}
.ms-btn-primary:hover { background: var(--ms-primary-hover); }

.ms-btn-secondary {
    background: var(--ms-bg);
    color: var(--ms-text);
    border: 1px solid var(--ms-border-strong);
}
.ms-btn-secondary:hover { background: var(--ms-bg-muted); }

.ms-btn-ghost {
    background: transparent;
    color: var(--ms-text-secondary);
}
.ms-btn-ghost:hover { background: var(--ms-bg-muted); color: var(--ms-text); }

.ms-btn-danger {
    background: var(--ms-danger);
    color: white;
}
.ms-btn-danger:hover { background: #DC2626; }

/* =================================================================
   PALETTE
   ================================================================= */
.ms-palette {
    background: var(--ms-bg);
    border: 1px solid var(--ms-border);
    border-radius: var(--ms-radius-lg);
    padding: 16px;
    margin-bottom: 20px;
}

.ms-palette-label {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--ms-text-muted);
    margin-bottom: 12px;
}

.ms-palette-tiles {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.ms-palette-tile {
    padding: 8px 14px;
    font-size: 13px;
    font-weight: 500;
    border: 2px solid;
    border-radius: var(--ms-radius-sm);
    cursor: grab;
    user-select: none;
    transition: all var(--ms-transition);
}

.ms-palette-tile:hover {
    transform: translateY(-2px);
    box-shadow: var(--ms-shadow-md);
}

.ms-palette-tile:active, .ms-palette-tile.dragging {
    cursor: grabbing;
    transform: scale(0.95);
    opacity: 0.8;
}

/* =================================================================
   GRID
   ================================================================= */
.ms-grid-container {
    background: var(--ms-bg);
    border: 1px solid var(--ms-border);
    border-radius: var(--ms-radius-lg);
    overflow: hidden;
    box-shadow: var(--ms-shadow-sm);
}

.ms-grid-inner {
    display: grid;
    min-width: fit-content;
}

.ms-grid-corner {
    background: var(--ms-bg-subtle);
    border-bottom: 1px solid var(--ms-border);
    border-right: 1px solid var(--ms-border);
}

.ms-grid-header {
    background: var(--div-color, var(--ms-primary));
    color: white;
    padding: 14px 16px;
    font-size: 13px;
    font-weight: 600;
    text-align: center;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    border-bottom: 1px solid var(--ms-border);
}

.ms-time-col {
    position: relative;
    background: var(--ms-bg-subtle);
    border-right: 1px solid var(--ms-border);
    min-width: 72px;
}

.ms-time-mark {
    position: absolute;
    left: 0;
    right: 0;
    padding: 2px 8px;
    font-size: 11px;
    font-weight: 500;
    color: var(--ms-text-muted);
    background: var(--ms-bg-subtle);
    border-top: 1px solid var(--ms-border);
}

.ms-time-hour {
    font-weight: 600;
    color: var(--ms-text-secondary);
}

.ms-grid-col {
    position: relative;
    background: var(--ms-bg);
    border-right: 1px solid var(--ms-border);
    transition: background-color var(--ms-transition);
}

.ms-grid-col:last-child { border-right: none; }

.ms-col-hover { background: #F0FDF4; }

.ms-hour-line {
    position: absolute;
    left: 0;
    right: 0;
    height: 1px;
    background: var(--ms-border);
    pointer-events: none;
}

.ms-disabled-zone {
    position: absolute;
    left: 0;
    right: 0;
    background: #E5E7EB;
    background-image: repeating-linear-gradient(
        -45deg,
        transparent,
        transparent 8px,
        rgba(107, 114, 128, 0.15) 8px,
        rgba(107, 114, 128, 0.15) 16px
    );
    z-index: 1;
}

/* =================================================================
   TILES
   ================================================================= */
.ms-tile {
    position: absolute;
    left: 4px;
    right: 4px;
    border: 2px solid;
    border-radius: var(--ms-radius-sm);
    cursor: pointer;
    z-index: 2;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 6px 10px;
    overflow: hidden;
    transition: all var(--ms-transition);
    box-shadow: var(--ms-shadow-sm);
}

.ms-tile:hover {
    transform: translateY(-1px);
    box-shadow: var(--ms-shadow-md);
    z-index: 3;
}

.ms-tile.selected {
    box-shadow: 0 0 0 2px var(--ms-primary), var(--ms-shadow-lg);
    z-index: 4;
}

.ms-tile.resizing {
    z-index: 100;
    box-shadow: 0 0 0 2px var(--ms-primary), var(--ms-shadow-xl);
}

.ms-tile-sm { padding: 2px 6px; }
.ms-tile-sm:hover { box-shadow: 0 0 0 2px var(--ms-danger); }

.ms-tile-content {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
}

.ms-tile-name {
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.ms-tile-time {
    font-size: 11px;
    opacity: 0.75;
    font-weight: 500;
}

.ms-tile-resize {
    position: absolute;
    left: 0;
    right: 0;
    height: 8px;
    cursor: ns-resize;
    opacity: 0;
    transition: opacity var(--ms-transition);
}

.ms-tile-resize-top { top: -2px; }
.ms-tile-resize-bottom { bottom: -2px; }

.ms-tile:hover .ms-tile-resize {
    opacity: 1;
    background: linear-gradient(to bottom, rgba(99, 102, 241, 0.3), transparent);
}

.ms-tile-resize-bottom:hover,
.ms-tile:hover .ms-tile-resize-bottom {
    background: linear-gradient(to top, rgba(99, 102, 241, 0.3), transparent);
}

/* =================================================================
   EMPTY STATE
   ================================================================= */
.ms-empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 80px 40px;
    text-align: center;
}

.ms-empty-icon {
    font-size: 48px;
    margin-bottom: 16px;
    opacity: 0.5;
}

.ms-empty-state h3 {
    margin: 0 0 8px 0;
    font-size: 18px;
    font-weight: 600;
    color: var(--ms-text);
}

.ms-empty-state p {
    margin: 0;
    font-size: 14px;
    color: var(--ms-text-secondary);
}

/* =================================================================
   MODAL
   ================================================================= */
.ms-modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    backdrop-filter: blur(4px);
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
}

.ms-modal {
    background: var(--ms-bg);
    border-radius: var(--ms-radius-lg);
    width: 100%;
    max-width: 480px;
    max-height: calc(100vh - 40px);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    box-shadow: var(--ms-shadow-xl);
    animation: modalIn 200ms ease-out;
}

@keyframes modalIn {
    from { opacity: 0; transform: scale(0.95) translateY(10px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
}

.ms-modal-header {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 20px 24px;
    border-bottom: 1px solid var(--ms-border);
}

.ms-modal-icon {
    width: 48px;
    height: 48px;
    border-radius: var(--ms-radius-md);
    border: 2px solid;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    font-weight: 700;
    flex-shrink: 0;
}

.ms-modal-title {
    flex: 1;
    min-width: 0;
}

.ms-modal-title h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
}

.ms-modal-title p {
    margin: 4px 0 0 0;
    font-size: 13px;
    color: var(--ms-text-secondary);
}

.ms-modal-close {
    width: 36px;
    height: 36px;
    border: none;
    background: transparent;
    border-radius: var(--ms-radius-sm);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--ms-text-muted);
    transition: all var(--ms-transition);
}

.ms-modal-close:hover {
    background: var(--ms-bg-muted);
    color: var(--ms-text);
}

.ms-modal-body {
    padding: 24px;
    overflow-y: auto;
}

.ms-modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    padding: 16px 24px;
    border-top: 1px solid var(--ms-border);
    background: var(--ms-bg-subtle);
}

/* Modal Form Fields */
.ms-field {
    margin-bottom: 20px;
}

.ms-field:last-child { margin-bottom: 0; }

.ms-field label {
    display: block;
    font-size: 13px;
    font-weight: 600;
    color: var(--ms-text);
    margin-bottom: 8px;
}

.ms-field input:not([type="checkbox"]),
.ms-field select {
    width: 100%;
    height: 40px;
    padding: 0 12px;
    font-size: 14px;
    font-family: var(--ms-font);
    color: var(--ms-text);
    background: var(--ms-bg);
    border: 1px solid var(--ms-border-strong);
    border-radius: var(--ms-radius-sm);
    transition: all var(--ms-transition);
}

.ms-field input:focus,
.ms-field select:focus {
    outline: none;
    border-color: var(--ms-primary);
    box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
}

.ms-input-lg {
    height: 44px !important;
    font-size: 15px !important;
}

.ms-field-row {
    display: flex;
    gap: 16px;
}

.ms-field-row .ms-field {
    flex: 1;
}

/* Time Picker */
.ms-time-picker {
    display: flex;
    align-items: center;
    gap: 16px;
    background: var(--ms-bg-subtle);
    padding: 16px;
    border-radius: var(--ms-radius-md);
}

.ms-time-group {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
}

.ms-time-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--ms-text-muted);
}

.ms-time-control {
    display: flex;
    align-items: center;
    gap: 4px;
    background: var(--ms-bg);
    padding: 4px;
    border-radius: var(--ms-radius-sm);
    border: 1px solid var(--ms-border);
}

.ms-time-btn {
    width: 28px;
    height: 28px;
    border: none;
    background: transparent;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--ms-text-secondary);
    transition: all var(--ms-transition);
}

.ms-time-btn:hover {
    background: var(--ms-bg-muted);
    color: var(--ms-text);
}

.ms-time-value {
    width: 80px;
    height: 32px;
    text-align: center;
    font-size: 14px;
    font-weight: 500;
    border: none !important;
    background: transparent !important;
    box-shadow: none !important;
}

.ms-time-divider {
    width: 16px;
    height: 2px;
    background: var(--ms-border-strong);
    border-radius: 1px;
}

.ms-duration-presets {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
    font-size: 13px;
    color: var(--ms-text-muted);
}

.ms-duration-presets button {
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 500;
    font-family: var(--ms-font);
    color: var(--ms-text-secondary);
    background: var(--ms-bg);
    border: 1px solid var(--ms-border);
    border-radius: 20px;
    cursor: pointer;
    transition: all var(--ms-transition);
}

.ms-duration-presets button:hover {
    background: var(--ms-bg-muted);
    border-color: var(--ms-border-strong);
    color: var(--ms-text);
}

/* Checkbox List */
.ms-checkbox-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 8px;
    max-height: 160px;
    overflow-y: auto;
    padding: 12px;
    background: var(--ms-bg-subtle);
    border: 1px solid var(--ms-border);
    border-radius: var(--ms-radius-sm);
}

.ms-checkbox-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    background: var(--ms-bg);
    border: 1px solid var(--ms-border);
    border-radius: var(--ms-radius-sm);
    cursor: pointer;
    font-size: 13px;
    transition: all var(--ms-transition);
}

.ms-checkbox-item:hover {
    border-color: var(--ms-border-strong);
    background: var(--ms-bg-muted);
}

.ms-checkbox-item input {
    width: 16px;
    height: 16px;
    margin: 0;
    accent-color: var(--ms-primary);
}

.ms-checkbox-meta {
    margin-left: auto;
    font-size: 10px;
    font-weight: 500;
    text-transform: uppercase;
    color: var(--ms-text-muted);
}

/* =================================================================
   TOAST
   ================================================================= */
.ms-toast {
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%) translateY(20px);
    background: var(--ms-text);
    color: white;
    padding: 12px 20px;
    border-radius: var(--ms-radius-md);
    font-size: 14px;
    font-weight: 500;
    font-family: var(--ms-font);
    z-index: 10001;
    opacity: 0;
    pointer-events: none;
    transition: all 300ms cubic-bezier(0.4, 0, 0.2, 1);
    box-shadow: var(--ms-shadow-lg);
}

.ms-toast.visible {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
}

/* =================================================================
   RESPONSIVE
   ================================================================= */
@media (max-width: 768px) {
    .ms-header { flex-direction: column; align-items: flex-start; gap: 16px; }
    .ms-toolbar { flex-direction: column; gap: 12px; }
    .ms-toolbar-left, .ms-toolbar-right { width: 100%; flex-wrap: wrap; }
    .ms-save-group, .ms-delete-group { border-left: none; padding-left: 0; }
    .ms-palette-tiles { gap: 6px; }
    .ms-palette-tile { padding: 6px 10px; font-size: 12px; }
}
</style>`;
}

// =================================================================
// INITIALIZATION
// =================================================================
function init() {
    container = document.getElementById("master-scheduler-content");
    if (!container) return;
    
    cleanupListeners();
    
    if (!loadDraft()) {
        loadDefaultSkeleton();
    }
    
    render();
    setupTabListeners();
    setupKeyboardShortcuts();
    
    _isInitialized = true;
    console.log("[MASTER_SCHEDULER] Premium Edition v5.0 initialized");
}

function cleanup() {
    cleanupListeners();
    document.getElementById('ms-modal')?.remove();
    document.getElementById('ms-toast')?.remove();
    _isInitialized = false;
}

// =================================================================
// PUBLIC API
// =================================================================
window.initMasterScheduler = init;
window.cleanupMasterScheduler = cleanup;
window.refreshMasterSchedulerFromCloud = refreshTemplateList;

})();
