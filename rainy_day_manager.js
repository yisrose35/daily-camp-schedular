// ============================================================================
// rainy_day_manager.js — RAINY DAY MODE SYSTEM (v2.1)
// ============================================================================
// Professional rainy day scheduling with:
// - Field rain availability configuration
// - Rainy day special activities
// - One-click rainy day activation
// - Automatic schedule adjustments
// - ★ NEW: Auto-skeleton switch (swap to rainy day skeleton template)
// - ★ NEW: Mid-day mode (reschedule from current time forward only)
// - ★ NEW: Cloud Sync integration for all state changes
// ============================================================================

(function() {
'use strict';

// =============================================================
// STATE
// =============================================================
let rainyDaySpecials = [];
let isRainyDayMode = false;

// =============================================================
// HELPER: CLOUD SYNC
// =============================================================
// ⭐ Cloud sync scheduler for rainy day changes
let _rainyDaySyncTimeout = null;

function scheduleRainyDayCloudSync() {
    clearTimeout(_rainyDaySyncTimeout);
    _rainyDaySyncTimeout = setTimeout(() => {
        if (typeof window.forceSyncToCloud === 'function') {
            console.log("☁️ [RainyDay] Syncing to cloud...");
            window.forceSyncToCloud();
        }
    }, 300);
}

// =============================================================
// LOAD + SAVE
// =============================================================
function loadRainyDayData() {
    const g = window.loadGlobalSettings?.() || {};
    rainyDaySpecials = g.rainyDaySpecials || [];
    
    // Load current day's rainy mode status
    const dailyData = window.loadCurrentDailyData?.() || {};
    isRainyDayMode = dailyData.rainyDayMode || false;
    
    return { rainyDaySpecials, isRainyDayMode };
}

function saveRainyDaySpecials() {
    window.saveGlobalSettings?.("rainyDaySpecials", rainyDaySpecials);
    scheduleRainyDayCloudSync();
}

function saveRainyDayMode(enabled) {
    isRainyDayMode = enabled;
    window.saveCurrentDailyData?.("rainyDayMode", enabled);
    
    // ⭐ Schedule cloud sync for rainy day state
    scheduleRainyDayCloudSync();
}

function uid() {
    return "rain_" + Math.random().toString(36).substring(2, 10);
}

// =============================================================
// SKELETON MANAGEMENT - Auto-switch to rainy day skeleton
// =============================================================

/**
 * Get the designated rainy day skeleton name from global settings
 */
function getRainyDaySkeletonName() {
    const g = window.loadGlobalSettings?.() || {};
    return g.rainyDaySkeletonName || null;
}

/**
 * Set the designated rainy day skeleton name
 */
function setRainyDaySkeletonName(skeletonName) {
    window.saveGlobalSettings?.("rainyDaySkeletonName", skeletonName);
    console.log(`[RainyDay] Rainy day skeleton set to: ${skeletonName || 'none'}`);
    scheduleRainyDayCloudSync(); // ⭐ Sync change
}

/**
 * Get available skeleton templates
 */
function getAvailableSkeletons() {
    const g = window.loadGlobalSettings?.() || {};
    const savedSkeletons = g.app1?.savedSkeletons || {};
    return Object.keys(savedSkeletons).sort();
}

/**
 * Get a skeleton template by name
 */
function getSkeletonByName(name) {
    const g = window.loadGlobalSettings?.() || {};
    const savedSkeletons = g.app1?.savedSkeletons || {};
    return savedSkeletons[name] || null;
}

/**
 * Save the current skeleton as pre-rainy backup
 */
function backupCurrentSkeleton() {
    const dailyData = window.loadCurrentDailyData?.() || {};
    const currentSkeleton = dailyData.manualSkeleton || [];
    
    if (currentSkeleton.length > 0) {
        window.saveCurrentDailyData?.("preRainyDayManualSkeleton", JSON.parse(JSON.stringify(currentSkeleton)));
        console.log(`[RainyDay] Backed up current skeleton (${currentSkeleton.length} blocks)`);
        // Note: No sync needed here as this is usually part of a larger operation that will sync
        return true;
    }
    return false;
}

/**
 * Restore the pre-rainy skeleton backup
 */
function restorePreRainySkeleton() {
    const dailyData = window.loadCurrentDailyData?.() || {};
    const backup = dailyData.preRainyDayManualSkeleton;
    
    if (backup && backup.length > 0) {
        window.saveCurrentDailyData?.("manualSkeleton", JSON.parse(JSON.stringify(backup)));
        window.saveCurrentDailyData?.("preRainyDayManualSkeleton", null);
        console.log(`[RainyDay] Restored pre-rainy skeleton (${backup.length} blocks)`);
        return true;
    }
    return false;
}

/**
 * Load the rainy day skeleton template into current day
 */
function loadRainyDaySkeleton() {
    const skeletonName = getRainyDaySkeletonName();
    if (!skeletonName) {
        console.log("[RainyDay] No rainy day skeleton configured");
        return false;
    }
    
    const skeleton = getSkeletonByName(skeletonName);
    if (!skeleton || skeleton.length === 0) {
        console.warn(`[RainyDay] Rainy day skeleton "${skeletonName}" not found or empty`);
        return false;
    }
    
    window.saveCurrentDailyData?.("manualSkeleton", JSON.parse(JSON.stringify(skeleton)));
    console.log(`[RainyDay] Loaded rainy day skeleton "${skeletonName}" (${skeleton.length} blocks)`);
    return true;
}

/**
 * Check if auto-skeleton switch is enabled
 */
function isAutoSkeletonSwitchEnabled() {
    const g = window.loadGlobalSettings?.() || {};
    return g.rainyDayAutoSkeletonSwitch === true;
}

/**
 * Enable/disable auto-skeleton switch
 */
function setAutoSkeletonSwitch(enabled) {
    window.saveGlobalSettings?.("rainyDayAutoSkeletonSwitch", enabled);
    scheduleRainyDayCloudSync(); // ⭐ Sync change
}

// =============================================================
// MID-DAY RAINY DAY MODE
// =============================================================

/**
 * Parse time string to minutes (e.g., "2:30pm" -> 870)
 */
function parseTimeToMinutes(str) {
    if (!str || typeof str !== "string") return null;
    let s = str.trim().toLowerCase();
    let mer = null;
    if (s.endsWith("am") || s.endsWith("pm")) {
        mer = s.endsWith("am") ? "am" : "pm";
        s = s.replace(/am|pm/g, "").trim();
    }
    const m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
    if (!m) return null;
    let hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (Number.isNaN(hh) || Number.isNaN(mm) || mm < 0 || mm > 59) return null;
    if (mer) {
        if (hh === 12) hh = mer === "am" ? 0 : 12;
        else if (mer === "pm") hh += 12;
    }
    return hh * 60 + mm;
}

/**
 * Convert minutes to time string (e.g., 870 -> "2:30pm")
 */
function minutesToTime(min) {
    let h = Math.floor(min / 60);
    let m = min % 60;
    const ap = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return h + ':' + m.toString().padStart(2, '0') + ap;
}

/**
 * Get current time in minutes since midnight
 */
function getCurrentTimeMinutes() {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
}

/**
 * Set mid-day rainy start time - preserves schedule before this time
 */
function setMidDayRainyStartTime(timeMinutes) {
    window.saveCurrentDailyData?.("rainyDayStartTime", timeMinutes);
    console.log(`[RainyDay] Mid-day start time set to: ${minutesToTime(timeMinutes)}`);
    scheduleRainyDayCloudSync(); // ⭐ Sync change
}

/**
 * Get mid-day rainy start time
 */
function getMidDayRainyStartTime() {
    const dailyData = window.loadCurrentDailyData?.() || {};
    return dailyData.rainyDayStartTime || null;
}

/**
 * Clear mid-day rainy start time
 */
function clearMidDayRainyStartTime() {
    window.saveCurrentDailyData?.("rainyDayStartTime", null);
    scheduleRainyDayCloudSync(); // ⭐ Sync change
}

/**
 * Check if mid-day mode is active
 */
function isMidDayModeActive() {
    return getMidDayRainyStartTime() !== null;
}

/**
 * Check if a time slot should be preserved (before rainy day start)
 */
function shouldPreserveSlot(slotStartMin) {
    const startTime = getMidDayRainyStartTime();
    if (startTime === null) return false; // Full day mode, don't preserve
    return slotStartMin < startTime;
}

/**
 * Get slots that should be preserved (before rainy day start)
 */
function getPreservedSlotIndices() {
    const startTime = getMidDayRainyStartTime();
    if (startTime === null) return []; // Full day mode
    
    const preserved = [];
    const times = window.unifiedTimes || [];
    
    for (let i = 0; i < times.length; i++) {
        const slot = times[i];
        const slotStart = new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes();
        if (slotStart < startTime) {
            preserved.push(i);
        }
    }
    
    return preserved;
}

/**
 * Backup schedule assignments before mid-day reschedule
 */
function backupPreservedSchedule() {
    const preserved = getPreservedSlotIndices();
    if (preserved.length === 0) return null;
    
    const schedules = window.scheduleAssignments || {};
    const backup = {};
    
    Object.keys(schedules).forEach(bunk => {
        backup[bunk] = {};
        preserved.forEach(slotIdx => {
            if (schedules[bunk]?.[slotIdx]) {
                backup[bunk][slotIdx] = JSON.parse(JSON.stringify(schedules[bunk][slotIdx]));
            }
        });
    });
    
    window.saveCurrentDailyData?.("preservedScheduleBackup", backup);
    console.log(`[RainyDay] Backed up ${preserved.length} preserved slots for ${Object.keys(backup).length} bunks`);
    return backup;
}

/**
 * Restore preserved schedule slots after regeneration
 */
function restorePreservedSchedule() {
    const dailyData = window.loadCurrentDailyData?.() || {};
    const backup = dailyData.preservedScheduleBackup;
    
    if (!backup) return false;
    
    const schedules = window.scheduleAssignments || {};
    let restored = 0;
    
    Object.keys(backup).forEach(bunk => {
        if (!schedules[bunk]) schedules[bunk] = [];
        
        Object.keys(backup[bunk]).forEach(slotIdxStr => {
            const slotIdx = parseInt(slotIdxStr, 10);
            schedules[bunk][slotIdx] = backup[bunk][slotIdx];
            restored++;
        });
    });
    
    window.scheduleAssignments = schedules;
    console.log(`[RainyDay] Restored ${restored} preserved schedule entries`);
    return true;
}

/**
 * Clear preserved schedule backup
 */
function clearPreservedScheduleBackup() {
    window.saveCurrentDailyData?.("preservedScheduleBackup", null);
}

// =============================================================
// FIELD RAINY DAY HELPERS
// =============================================================
function getFieldRainyDayStatus(fieldName) {
    const g = window.loadGlobalSettings?.() || {};
    const fields = g.app1?.fields || [];
    const field = fields.find(f => f.name === fieldName);
    return field?.rainyDayAvailable ?? false;
}

function setFieldRainyDayStatus(fieldName, available) {
    const g = window.loadGlobalSettings?.() || {};
    const fields = g.app1?.fields || [];
    const field = fields.find(f => f.name === fieldName);
    if (field) {
        field.rainyDayAvailable = available;
        window.saveGlobalSettings?.("app1", g.app1);
        scheduleRainyDayCloudSync(); // ⭐ Sync change
    }
}

function getRainyDayAvailableFields() {
    const g = window.loadGlobalSettings?.() || {};
    const fields = g.app1?.fields || [];
    return fields.filter(f => f.rainyDayAvailable === true).map(f => f.name);
}

function getRainyDayUnavailableFields() {
    const g = window.loadGlobalSettings?.() || {};
    const fields = g.app1?.fields || [];
    return fields.filter(f => f.rainyDayAvailable !== true).map(f => f.name);
}

// =============================================================
// SPECIAL ACTIVITIES RAINY DAY HELPERS
// =============================================================
function getSpecialRainyDayStatus(specialName) {
    const g = window.loadGlobalSettings?.() || {};
    const specials = g.app1?.specialActivities || [];
    const special = specials.find(s => s.name === specialName);
    return {
        isRainyDayOnly: special?.rainyDayOnly ?? false,
        availableOnRainyDay: special?.availableOnRainyDay ?? true
    };
}

function setSpecialRainyDayStatus(specialName, { isRainyDayOnly, availableOnRainyDay }) {
    const g = window.loadGlobalSettings?.() || {};
    const specials = g.app1?.specialActivities || [];
    const special = specials.find(s => s.name === specialName);
    if (special) {
        if (isRainyDayOnly !== undefined) special.rainyDayOnly = isRainyDayOnly;
        if (availableOnRainyDay !== undefined) special.availableOnRainyDay = availableOnRainyDay;
        window.saveGlobalSettings?.("app1", g.app1);
        scheduleRainyDayCloudSync(); // ⭐ Sync change
    }
}

function getRainyDayOnlySpecials() {
    const g = window.loadGlobalSettings?.() || {};
    const specials = g.app1?.specialActivities || [];
    return specials.filter(s => s.rainyDayOnly === true);
}

function getRainyDayAvailableSpecials() {
    const g = window.loadGlobalSettings?.() || {};
    const specials = g.app1?.specialActivities || [];
    return specials.filter(s => s.availableOnRainyDay !== false);
}

// =============================================================
// RAINY DAY MODE ACTIVATION LOGIC (ENHANCED)
// =============================================================

/**
 * Activate rainy day mode - full day
 * @param {Object} options - { autoSwitchSkeleton: boolean }
 */
function activateRainyDayMode(options = {}) {
    const { autoSwitchSkeleton = true } = options;
    
    saveRainyDayMode(true);
    clearMidDayRainyStartTime(); // Full day mode
    
    // Get current daily overrides
    const dailyData = window.loadCurrentDailyData?.() || {};
    const overrides = dailyData.overrides || {};
    
    // Store original disabled fields before rainy day (for restoration)
    if (!dailyData.preRainyDayDisabledFields) {
        window.saveCurrentDailyData?.("preRainyDayDisabledFields", overrides.disabledFields || []);
    }
    
    // Disable all non-rainy-day-available fields
    const unavailableFields = getRainyDayUnavailableFields();
    const existingDisabled = overrides.disabledFields || [];
    const newDisabled = [...new Set([...existingDisabled, ...unavailableFields])];
    
    overrides.disabledFields = newDisabled;
    window.saveCurrentDailyData?.("overrides", overrides);
    
    // Auto-switch skeleton if enabled
    let skeletonSwitched = false;
    if (autoSwitchSkeleton && isAutoSkeletonSwitchEnabled()) {
        backupCurrentSkeleton();
        skeletonSwitched = loadRainyDaySkeleton();
    }
    
    console.log(`[RainyDay] Activated! Disabled ${unavailableFields.length} outdoor fields. Skeleton switched: ${skeletonSwitched}`);
    
    // Final sync for all the operations above
    scheduleRainyDayCloudSync();

    return {
        disabledFields: unavailableFields,
        availableFields: getRainyDayAvailableFields(),
        rainyDaySpecials: getRainyDayOnlySpecials().map(s => s.name),
        skeletonSwitched
    };
}

/**
 * Activate mid-day rainy day mode - preserve past schedule
 * @param {number|string} startTime - Time to start rainy day (minutes or "2:30pm")
 * @param {Object} options - { autoSwitchSkeleton: boolean }
 */
function activateMidDayRainyMode(startTime, options = {}) {
    const { autoSwitchSkeleton = true } = options;
    
    // Parse start time
    let startMin;
    if (typeof startTime === 'number') {
        startMin = startTime;
    } else if (typeof startTime === 'string') {
        startMin = parseTimeToMinutes(startTime);
    } else {
        // Default to current time
        startMin = getCurrentTimeMinutes();
    }
    
    // Fix #1 - 🟡 MEDIUM: Mid-Day Mode No Future Validation
    if (startMin === null) {
        console.error("[RainyDay] Invalid start time for mid-day mode");
        return null;
    }

    // Warn if time is in the past
    const now = new Date();
    const currentMin = now.getHours() * 60 + now.getMinutes();
    if (startMin < currentMin) {
        console.warn(`[RainyDay] Start time is before current time - proceeding anyway`);
    }
    
    saveRainyDayMode(true);
    setMidDayRainyStartTime(startMin);
    
    // Backup current schedule for preservation
    backupPreservedSchedule();
    
    // Get current daily overrides
    const dailyData = window.loadCurrentDailyData?.() || {};
    const overrides = dailyData.overrides || {};
    
    // Store original disabled fields
    if (!dailyData.preRainyDayDisabledFields) {
        window.saveCurrentDailyData?.("preRainyDayDisabledFields", overrides.disabledFields || []);
    }
    
    // Disable outdoor fields
    const unavailableFields = getRainyDayUnavailableFields();
    const existingDisabled = overrides.disabledFields || [];
    const newDisabled = [...new Set([...existingDisabled, ...unavailableFields])];
    
    overrides.disabledFields = newDisabled;
    window.saveCurrentDailyData?.("overrides", overrides);
    
    // Auto-switch skeleton if enabled (for future blocks only)
    let skeletonSwitched = false;
    if (autoSwitchSkeleton && isAutoSkeletonSwitchEnabled()) {
        backupCurrentSkeleton();
        skeletonSwitched = loadRainyDaySkeleton();
    }
    
    console.log(`[RainyDay] Mid-day mode activated from ${minutesToTime(startMin)}!`);
    console.log(`[RainyDay] ${getPreservedSlotIndices().length} slots will be preserved.`);
    
    // Final sync for all operations
    scheduleRainyDayCloudSync();

    return {
        startTime: startMin,
        startTimeStr: minutesToTime(startMin),
        disabledFields: unavailableFields,
        preservedSlots: getPreservedSlotIndices().length,
        skeletonSwitched
    };
}

function deactivateRainyDayMode() {
    saveRainyDayMode(false);
    clearMidDayRainyStartTime();
    clearPreservedScheduleBackup();
    
    // Restore original disabled fields
    const dailyData = window.loadCurrentDailyData?.() || {};
    const preRainyDisabled = dailyData.preRainyDayDisabledFields || [];
    
    const overrides = dailyData.overrides || {};
    overrides.disabledFields = preRainyDisabled;
    window.saveCurrentDailyData?.("overrides", overrides);
    window.saveCurrentDailyData?.("preRainyDayDisabledFields", null);
    
    // Restore original skeleton if we switched it
    if (isAutoSkeletonSwitchEnabled()) {
        restorePreRainySkeleton();
    }
    
    console.log(`[RainyDay] Deactivated! Restored normal field availability.`);
    
    // Sync deactivation
    scheduleRainyDayCloudSync();
}

function isRainyDayActive() {
    const dailyData = window.loadCurrentDailyData?.() || {};
    return dailyData.rainyDayMode === true;
}

// =============================================================
// SCHEDULER INTEGRATION
// =============================================================
function getEffectiveFieldAvailability() {
    if (!isRainyDayActive()) {
        return null;
    }
    
    return {
        disabledFields: getRainyDayUnavailableFields(),
        additionalSpecials: getRainyDayOnlySpecials(),
        midDayStartTime: getMidDayRainyStartTime(),
        preservedSlots: getPreservedSlotIndices()
    };
}

// =============================================================
// UI COMPONENT: RAINY DAY TOGGLE (ENHANCED)
// =============================================================
function createRainyDayToggleUI(container, onToggle) {
    const isActive = isRainyDayActive();
    const isMidDay = isMidDayModeActive();
    const midDayStartTime = getMidDayRainyStartTime();
    const availableFields = getRainyDayAvailableFields();
    const unavailableFields = getRainyDayUnavailableFields();
    const rainySpecials = getRainyDayOnlySpecials();
    const autoSwitch = isAutoSkeletonSwitchEnabled();
    const rainySkeletonName = getRainyDaySkeletonName();
    const availableSkeletons = getAvailableSkeletons();
    
    const html = `
        <style>
            .rainy-day-card {
                border-radius: 16px;
                overflow: hidden;
                margin-bottom: 20px;
                transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
                position: relative;
            }
            
            .rainy-day-card.inactive {
                background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
                border: 1px solid #e2e8f0;
            }
            
            .rainy-day-card.active {
                background: linear-gradient(135deg, #1e3a5f 0%, #0c4a6e 50%, #164e63 100%);
                border: 1px solid #0ea5e9;
                box-shadow: 
                    0 0 40px rgba(14, 165, 233, 0.15),
                    0 20px 40px rgba(15, 23, 42, 0.2),
                    inset 0 1px 0 rgba(255, 255, 255, 0.1);
            }
            
            .rainy-day-header {
                padding: 20px 24px;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            
            .rainy-day-title-section {
                display: flex;
                align-items: center;
                gap: 14px;
            }
            
            .rainy-day-icon {
                width: 48px;
                height: 48px;
                border-radius: 12px;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 24px;
                transition: all 0.4s ease;
            }
            
            .rainy-day-card.inactive .rainy-day-icon {
                background: #e2e8f0;
            }
            
            .rainy-day-card.active .rainy-day-icon {
                background: rgba(14, 165, 233, 0.2);
                box-shadow: 0 0 20px rgba(14, 165, 233, 0.3);
                animation: iconPulse 2s ease-in-out infinite;
            }
            
            @keyframes iconPulse {
                0%, 100% { transform: scale(1); }
                50% { transform: scale(1.05); }
            }
            
            .rainy-day-title {
                font-size: 1.1rem;
                font-weight: 600;
                margin: 0;
                transition: color 0.3s ease;
            }
            
            .rainy-day-card.inactive .rainy-day-title { color: #334155; }
            .rainy-day-card.active .rainy-day-title { color: #f0f9ff; }
            
            .rainy-day-subtitle {
                font-size: 0.85rem;
                margin: 2px 0 0;
                transition: color 0.3s ease;
            }
            
            .rainy-day-card.inactive .rainy-day-subtitle { color: #64748b; }
            .rainy-day-card.active .rainy-day-subtitle { color: #7dd3fc; }
            
            /* Toggle Switch */
            .rainy-toggle-container {
                display: flex;
                align-items: center;
                gap: 12px;
            }
            
            .rainy-toggle-label {
                font-size: 0.85rem;
                font-weight: 500;
                transition: color 0.3s ease;
            }
            
            .rainy-day-card.inactive .rainy-toggle-label { color: #64748b; }
            .rainy-day-card.active .rainy-toggle-label { color: #bae6fd; }
            
            .rainy-toggle {
                position: relative;
                width: 56px;
                height: 28px;
                cursor: pointer;
            }
            
            .rainy-toggle input {
                opacity: 0;
                width: 0;
                height: 0;
            }
            
            .rainy-toggle-track {
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: #cbd5e1;
                border-radius: 28px;
                transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
            }
            
            .rainy-toggle input:checked + .rainy-toggle-track {
                background: linear-gradient(135deg, #0ea5e9, #06b6d4);
                box-shadow: 0 0 16px rgba(14, 165, 233, 0.5);
            }
            
            .rainy-toggle-thumb {
                position: absolute;
                top: 2px;
                left: 2px;
                width: 24px;
                height: 24px;
                background: white;
                border-radius: 50%;
                transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 12px;
            }
            
            .rainy-toggle input:checked ~ .rainy-toggle-thumb {
                left: 30px;
                background: #f0f9ff;
            }
            
            /* Status Panel */
            .rainy-status-panel {
                padding: 0 24px 20px;
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
                gap: 12px;
            }
            
            .rainy-stat-box {
                padding: 14px 16px;
                border-radius: 10px;
                transition: all 0.3s ease;
            }
            
            .rainy-day-card.inactive .rainy-stat-box {
                background: white;
                border: 1px solid #e2e8f0;
            }
            
            .rainy-day-card.active .rainy-stat-box {
                background: rgba(255, 255, 255, 0.08);
                border: 1px solid rgba(255, 255, 255, 0.12);
                backdrop-filter: blur(8px);
            }
            
            .rainy-stat-label {
                font-size: 0.7rem;
                font-weight: 500;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                margin-bottom: 4px;
            }
            
            .rainy-day-card.inactive .rainy-stat-label { color: #94a3b8; }
            .rainy-day-card.active .rainy-stat-label { color: #7dd3fc; }
            
            .rainy-stat-value {
                font-size: 1.4rem;
                font-weight: 700;
            }
            
            .rainy-day-card.inactive .rainy-stat-value { color: #334155; }
            .rainy-day-card.active .rainy-stat-value { color: #f0f9ff; }
            
            .rainy-stat-detail {
                font-size: 0.75rem;
                margin-top: 2px;
            }
            
            .rainy-day-card.inactive .rainy-stat-detail { color: #64748b; }
            .rainy-day-card.active .rainy-stat-detail { color: #bae6fd; }
            
            /* Settings Panel */
            .rainy-settings-panel {
                padding: 16px 24px;
                border-top: 1px solid rgba(255,255,255,0.1);
            }
            
            .rainy-day-card.inactive .rainy-settings-panel {
                border-top-color: #e2e8f0;
                background: #fafafa;
            }
            
            .rainy-day-card.active .rainy-settings-panel {
                background: rgba(0,0,0,0.15);
            }
            
            .rainy-settings-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 12px;
                gap: 12px;
            }
            
            .rainy-settings-row:last-child {
                margin-bottom: 0;
            }
            
            .rainy-settings-label {
                font-size: 0.85rem;
                font-weight: 500;
            }
            
            .rainy-day-card.inactive .rainy-settings-label { color: #475569; }
            .rainy-day-card.active .rainy-settings-label { color: #e0f2fe; }
            
            .rainy-settings-sublabel {
                font-size: 0.75rem;
                opacity: 0.7;
            }
            
            .rainy-settings-select {
                padding: 8px 12px;
                border-radius: 8px;
                font-size: 0.85rem;
                min-width: 180px;
            }
            
            .rainy-day-card.inactive .rainy-settings-select {
                background: white;
                border: 1px solid #d1d5db;
                color: #374151;
            }
            
            .rainy-day-card.active .rainy-settings-select {
                background: rgba(255,255,255,0.1);
                border: 1px solid rgba(255,255,255,0.2);
                color: #f0f9ff;
            }
            
            /* Mid-day Button */
            .rainy-midday-btn {
                padding: 10px 16px;
                border-radius: 10px;
                font-size: 0.85rem;
                font-weight: 600;
                cursor: pointer;
                display: flex;
                align-items: center;
                gap: 8px;
                transition: all 0.2s ease;
                border: none;
            }
            
            .rainy-midday-btn.primary {
                background: linear-gradient(135deg, #f59e0b, #d97706);
                color: white;
            }
            
            .rainy-midday-btn.primary:hover {
                transform: translateY(-1px);
                box-shadow: 0 4px 12px rgba(245, 158, 11, 0.3);
            }
            
            .rainy-midday-badge {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                padding: 4px 10px;
                background: rgba(245, 158, 11, 0.2);
                border: 1px solid rgba(245, 158, 11, 0.3);
                border-radius: 999px;
                font-size: 0.75rem;
                font-weight: 600;
                color: #fbbf24;
            }
            
            /* Rain Animation */
            .rain-animation-container {
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                overflow: hidden;
                pointer-events: none;
                opacity: 0;
                transition: opacity 0.5s ease;
                border-radius: 16px;
            }
            
            .rainy-day-card.active .rain-animation-container {
                opacity: 1;
            }
            
            .rain-drop {
                position: absolute;
                width: 2px;
                background: linear-gradient(to bottom, transparent, rgba(186, 230, 253, 0.4));
                animation: rainFall linear infinite;
            }
            
            @keyframes rainFall {
                0% {
                    transform: translateY(-100%);
                    opacity: 0;
                }
                10% {
                    opacity: 1;
                }
                90% {
                    opacity: 1;
                }
                100% {
                    transform: translateY(300px);
                    opacity: 0;
                }
            }
            
            /* Status Badge */
            .rainy-status-badge {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 6px 14px;
                border-radius: 999px;
                font-size: 0.8rem;
                font-weight: 600;
                transition: all 0.3s ease;
            }
            
            .rainy-status-badge.active {
                background: rgba(14, 165, 233, 0.2);
                color: #7dd3fc;
                border: 1px solid rgba(14, 165, 233, 0.3);
            }
            
            .rainy-status-badge.inactive {
                background: #f1f5f9;
                color: #64748b;
                border: 1px solid #e2e8f0;
            }
            
            .status-dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
            }
            
            .status-dot.active {
                background: #22d3ee;
                box-shadow: 0 0 8px #22d3ee;
                animation: statusPulse 1.5s ease-in-out infinite;
            }
            
            .status-dot.inactive {
                background: #94a3b8;
            }
            
            @keyframes statusPulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.5; }
            }
            
            /* Mini Toggle */
            .rainy-mini-toggle {
                position: relative;
                width: 40px;
                height: 20px;
                cursor: pointer;
            }
            
            .rainy-mini-toggle input {
                opacity: 0;
                width: 0;
                height: 0;
            }
            
            .rainy-mini-toggle .track {
                position: absolute;
                top: 0; left: 0; right: 0; bottom: 0;
                background: #d1d5db;
                border-radius: 20px;
                transition: 0.3s;
            }
            
            .rainy-mini-toggle input:checked + .track {
                background: #10b981;
            }
            
            .rainy-day-card.active .rainy-mini-toggle input:checked + .track {
                background: #22d3ee;
            }
            
            .rainy-mini-toggle .thumb {
                position: absolute;
                top: 2px;
                left: 2px;
                width: 16px;
                height: 16px;
                background: white;
                border-radius: 50%;
                transition: 0.3s;
                box-shadow: 0 1px 3px rgba(0,0,0,0.2);
            }
            
            .rainy-mini-toggle input:checked ~ .thumb {
                left: 22px;
            }
        </style>
        
        <div class="rainy-day-card ${isActive ? 'active' : 'inactive'}" id="rainy-day-card">
            <!-- Rain Animation -->
            <div class="rain-animation-container" id="rain-animation">
                ${generateRainDrops(20)}
            </div>
            
            <div class="rainy-day-header" style="position: relative; z-index: 1;">
                <div class="rainy-day-title-section">
                    <div class="rainy-day-icon">
                        ${isActive ? '🌧️' : '☀️'}
                    </div>
                    <div>
                        <h3 class="rainy-day-title">Rainy Day Mode</h3>
                        <p class="rainy-day-subtitle">
                            ${isActive 
                                ? (isMidDay 
                                    ? `Mid-day mode from ${minutesToTime(midDayStartTime)}` 
                                    : 'Full day indoor schedule active')
                                : 'Standard outdoor schedule'}
                        </p>
                    </div>
                </div>
                
                <div class="rainy-toggle-container">
                    ${isMidDay ? `<span class="rainy-midday-badge">⏰ From ${minutesToTime(midDayStartTime)}</span>` : ''}
                    
                    <span class="rainy-status-badge ${isActive ? 'active' : 'inactive'}">
                        <span class="status-dot ${isActive ? 'active' : 'inactive'}"></span>
                        ${isActive ? 'ACTIVE' : 'INACTIVE'}
                    </span>
                    
                    <label class="rainy-toggle">
                        <input type="checkbox" id="rainy-day-toggle" ${isActive ? 'checked' : ''}>
                        <span class="rainy-toggle-track"></span>
                        <span class="rainy-toggle-thumb">
                            ${isActive ? '💧' : '☀️'}
                        </span>
                    </label>
                </div>
            </div>
            
            <div class="rainy-status-panel" style="position: relative; z-index: 1;">
                <div class="rainy-stat-box">
                    <div class="rainy-stat-label">Indoor Fields</div>
                    <div class="rainy-stat-value">${availableFields.length}</div>
                    <div class="rainy-stat-detail">Available</div>
                </div>
                <div class="rainy-stat-box">
                    <div class="rainy-stat-label">Outdoor Fields</div>
                    <div class="rainy-stat-value">${unavailableFields.length}</div>
                    <div class="rainy-stat-detail">${isActive ? 'Disabled' : 'Active'}</div>
                </div>
                <div class="rainy-stat-box">
                    <div class="rainy-stat-label">Rainy Activities</div>
                    <div class="rainy-stat-value">${rainySpecials.length}</div>
                    <div class="rainy-stat-detail">${isActive ? 'Activated' : 'On Standby'}</div>
                </div>
                ${isMidDay ? `
                <div class="rainy-stat-box">
                    <div class="rainy-stat-label">Preserved</div>
                    <div class="rainy-stat-value">${getPreservedSlotIndices().length}</div>
                    <div class="rainy-stat-detail">Slots kept</div>
                </div>
                ` : ''}
            </div>
            
            <!-- Settings Panel -->
            <div class="rainy-settings-panel" style="position: relative; z-index: 1;">
                <div class="rainy-settings-row">
                    <div>
                        <div class="rainy-settings-label">Auto-Switch Skeleton</div>
                        <div class="rainy-settings-sublabel">Swap to rainy day template when activated</div>
                    </div>
                    <label class="rainy-mini-toggle">
                        <input type="checkbox" id="rainy-auto-skeleton-toggle" ${autoSwitch ? 'checked' : ''}>
                        <span class="track"></span>
                        <span class="thumb"></span>
                    </label>
                </div>
                
                <div class="rainy-settings-row">
                    <div>
                        <div class="rainy-settings-label">Rainy Day Skeleton</div>
                        <div class="rainy-settings-sublabel">Template to use when rainy mode is on</div>
                    </div>
                    <select id="rainy-skeleton-select" class="rainy-settings-select">
                        <option value="">-- None Selected --</option>
                        ${availableSkeletons.map(name => 
                            `<option value="${name}" ${name === rainySkeletonName ? 'selected' : ''}>${name}</option>`
                        ).join('')}
                    </select>
                </div>
                
                ${!isActive ? `
                <div class="rainy-settings-row" style="margin-top: 16px; padding-top: 16px; border-top: 1px solid rgba(128,128,128,0.2);">
                    <div>
                        <div class="rainy-settings-label">⏰ Mid-Day Rainy Mode</div>
                        <div class="rainy-settings-sublabel">Keep morning schedule, only change afternoon</div>
                    </div>
                    <button class="rainy-midday-btn primary" id="rainy-midday-btn">
                        <span>🌧️</span> Start From Now
                    </button>
                </div>
                ` : ''}
            </div>
        </div>
    `;
    
    container.innerHTML = html;
    
    // Bind main toggle event
    const toggle = container.querySelector('#rainy-day-toggle');
    toggle.addEventListener('change', function() {
        const newState = this.checked;
        
        if (newState) {
            const result = activateRainyDayMode({ autoSwitchSkeleton: true });
            showActivationNotification(true, result);
        } else {
            deactivateRainyDayMode();
            showActivationNotification(false);
        }
        
        // Re-render the UI
        createRainyDayToggleUI(container, onToggle);
        
        // Callback for parent component
        if (onToggle) onToggle(newState, false);
    });
    
    // Bind auto-skeleton toggle
    const autoSkeletonToggle = container.querySelector('#rainy-auto-skeleton-toggle');
    if (autoSkeletonToggle) {
        autoSkeletonToggle.addEventListener('change', function() {
            setAutoSkeletonSwitch(this.checked);
        });
    }
    
    // Bind skeleton select
    const skeletonSelect = container.querySelector('#rainy-skeleton-select');
    if (skeletonSelect) {
        skeletonSelect.addEventListener('change', function() {
            setRainyDaySkeletonName(this.value || null);
        });
    }
    
    // Bind mid-day button
    const midDayBtn = container.querySelector('#rainy-midday-btn');
    if (midDayBtn) {
        midDayBtn.addEventListener('click', function() {
            // Ask user for start time
            const currentTime = minutesToTime(getCurrentTimeMinutes());
            const inputTime = prompt(
                "Enter the time to start rainy day mode:\n\n" +
                "Everything BEFORE this time will be preserved.\n" +
                "Only future slots will use rainy day settings.\n\n" +
                "Format: 2:30pm, 10:00am, etc.",
                currentTime
            );
            
            if (!inputTime) return;
            
            const parsedTime = parseTimeToMinutes(inputTime);
            if (parsedTime === null) {
                alert("Invalid time format. Please use format like '2:30pm' or '10:00am'.");
                return;
            }
            
            const result = activateMidDayRainyMode(parsedTime, { autoSwitchSkeleton: true });
            if (result) {
                showMidDayActivationNotification(result);
                createRainyDayToggleUI(container, onToggle);
                if (onToggle) onToggle(true, true); // true = mid-day mode
            }
        });
    }
}

function generateRainDrops(count) {
    let drops = '';
    for (let i = 0; i < count; i++) {
        const left = Math.random() * 100;
        const delay = Math.random() * 2;
        const duration = 0.8 + Math.random() * 0.4;
        const height = 15 + Math.random() * 20;
        drops += `<div class="rain-drop" style="left: ${left}%; animation-delay: ${delay}s; animation-duration: ${duration}s; height: ${height}px;"></div>`;
    }
    return drops;
}

function showActivationNotification(activated, details) {
    const notif = document.createElement('div');
    notif.style.cssText = `
        position: fixed;
        top: 80px;
        right: 20px;
        padding: 16px 24px;
        border-radius: 12px;
        z-index: 10000;
        display: flex;
        align-items: center;
        gap: 12px;
        font-weight: 500;
        animation: slideIn 0.3s ease-out;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
    `;
    
    if (activated) {
        notif.style.background = 'linear-gradient(135deg, #0c4a6e, #164e63)';
        notif.style.color = '#f0f9ff';
        notif.style.border = '1px solid rgba(14, 165, 233, 0.3)';
        notif.innerHTML = `
            <span style="font-size: 24px;">🌧️</span>
            <div>
                <div style="font-weight: 600;">Rainy Day Mode Activated</div>
                <div style="font-size: 0.85rem; opacity: 0.8; margin-top: 2px;">
                    ${details?.disabledFields?.length || 0} outdoor fields disabled
                    ${details?.skeletonSwitched ? ' • Skeleton switched' : ''}
                </div>
            </div>
        `;
    } else {
        notif.style.background = 'linear-gradient(135deg, #fef3c7, #fef9c3)';
        notif.style.color = '#92400e';
        notif.style.border = '1px solid #fbbf24';
        notif.innerHTML = `
            <span style="font-size: 24px;">☀️</span>
            <div>
                <div style="font-weight: 600;">Normal Mode Restored</div>
                <div style="font-size: 0.85rem; opacity: 0.8; margin-top: 2px;">
                    All fields back to normal availability
                </div>
            </div>
        `;
    }
    
    // Add animation keyframes
    const style = document.createElement('style');
    style.textContent = `
        @keyframes slideIn {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }
        @keyframes slideOut {
            from { transform: translateX(0); opacity: 1; }
            to { transform: translateX(100%); opacity: 0; }
        }
    `;
    document.head.appendChild(style);
    
    document.body.appendChild(notif);
    
    setTimeout(() => {
        notif.style.animation = 'slideOut 0.3s ease-in forwards';
        setTimeout(() => notif.remove(), 300);
    }, 3000);
}

function showMidDayActivationNotification(details) {
    const notif = document.createElement('div');
    notif.style.cssText = `
        position: fixed;
        top: 80px;
        right: 20px;
        padding: 16px 24px;
        border-radius: 12px;
        z-index: 10000;
        display: flex;
        align-items: center;
        gap: 12px;
        font-weight: 500;
        animation: slideIn 0.3s ease-out;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
        background: linear-gradient(135deg, #78350f, #92400e);
        color: #fef3c7;
        border: 1px solid rgba(251, 191, 36, 0.3);
    `;
    
    notif.innerHTML = `
        <span style="font-size: 24px;">⏰</span>
        <div>
            <div style="font-weight: 600;">Mid-Day Rainy Mode Activated</div>
            <div style="font-size: 0.85rem; opacity: 0.85; margin-top: 2px;">
                From ${details.startTimeStr} • ${details.preservedSlots} slots preserved
                ${details.skeletonSwitched ? ' • Skeleton switched' : ''}
            </div>
        </div>
    `;
    
    document.body.appendChild(notif);
    
    setTimeout(() => {
        notif.style.animation = 'slideOut 0.3s ease-in forwards';
        setTimeout(() => notif.remove(), 300);
    }, 4000);
}

// =============================================================
// CONFIGURATION PANEL UI
// =============================================================
function createRainyDayConfigPanel(container) {
    loadRainyDayData();
    
    const g = window.loadGlobalSettings?.() || {};
    const fields = g.app1?.fields || [];
    const specials = g.app1?.specialActivities || [];
    
    container.innerHTML = `
        <style>
            .rd-config-section {
                background: white;
                border: 1px solid #e5e7eb;
                border-radius: 12px;
                padding: 20px;
                margin-bottom: 16px;
            }
            
            .rd-config-title {
                font-size: 1rem;
                font-weight: 600;
                color: #111827;
                margin: 0 0 4px 0;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            
            .rd-config-desc {
                font-size: 0.85rem;
                color: #6b7280;
                margin: 0 0 16px 0;
            }
            
            .rd-item-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
                gap: 10px;
            }
            
            .rd-item-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 10px 14px;
                background: #f9fafb;
                border: 1px solid #e5e7eb;
                border-radius: 8px;
                transition: all 0.15s ease;
            }
            
            .rd-item-row:hover {
                background: #f3f4f6;
                border-color: #d1d5db;
            }
            
            .rd-item-row.indoor {
                background: #ecfdf5;
                border-color: #a7f3d0;
            }
            
            .rd-item-row.rainy-only {
                background: #eff6ff;
                border-color: #93c5fd;
            }
            
            .rd-item-name {
                font-weight: 500;
                color: #374151;
                font-size: 0.9rem;
            }
            
            .rd-item-badge {
                font-size: 0.7rem;
                padding: 2px 8px;
                border-radius: 999px;
                font-weight: 600;
            }
            
            .rd-badge-indoor {
                background: #d1fae5;
                color: #065f46;
            }
            
            .rd-badge-outdoor {
                background: #fef3c7;
                color: #92400e;
            }
            
            .rd-badge-rainy {
                background: #dbeafe;
                color: #1e40af;
            }
            
            /* Mini Toggle */
            .rd-mini-toggle {
                position: relative;
                width: 36px;
                height: 18px;
                cursor: pointer;
            }
            
            .rd-mini-toggle input {
                opacity: 0;
                width: 0;
                height: 0;
            }
            
            .rd-mini-toggle .track {
                position: absolute;
                top: 0; left: 0; right: 0; bottom: 0;
                background: #d1d5db;
                border-radius: 18px;
                transition: 0.3s;
            }
            
            .rd-mini-toggle input:checked + .track {
                background: #10b981;
            }
            
            .rd-mini-toggle .thumb {
                position: absolute;
                top: 2px;
                left: 2px;
                width: 14px;
                height: 14px;
                background: white;
                border-radius: 50%;
                transition: 0.3s;
                box-shadow: 0 1px 3px rgba(0,0,0,0.2);
            }
            
            .rd-mini-toggle input:checked ~ .thumb {
                left: 20px;
            }
            
            .rd-summary-box {
                background: linear-gradient(135deg, #f0f9ff, #e0f2fe);
                border: 1px solid #7dd3fc;
                border-radius: 10px;
                padding: 16px;
                margin-top: 20px;
            }
            
            .rd-summary-title {
                font-weight: 600;
                color: #0c4a6e;
                margin-bottom: 10px;
            }
            
            .rd-summary-stats {
                display: flex;
                gap: 20px;
                flex-wrap: wrap;
            }
            
            .rd-summary-stat {
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 0.9rem;
                color: #0369a1;
            }
            
            .rd-summary-stat strong {
                font-size: 1.1rem;
            }
        </style>
        
        <div class="rd-config-section">
            <h3 class="rd-config-title">🏟️ Field Rainy Day Availability</h3>
            <p class="rd-config-desc">
                Mark fields as "Indoor" to keep them available during rainy days. 
                Outdoor fields will be automatically disabled when Rainy Day Mode is activated.
            </p>
            
            <div class="rd-item-grid" id="rd-fields-grid">
                ${fields.map(f => {
                    const isIndoor = f.rainyDayAvailable === true;
                    return `
                        <div class="rd-item-row ${isIndoor ? 'indoor' : ''}">
                            <div>
                                <div class="rd-item-name">${f.name}</div>
                                <span class="rd-item-badge ${isIndoor ? 'rd-badge-indoor' : 'rd-badge-outdoor'}">
                                    ${isIndoor ? '🏠 Indoor' : '🌳 Outdoor'}
                                </span>
                            </div>
                            <label class="rd-mini-toggle">
                                <input type="checkbox" 
                                       data-field="${f.name}" 
                                       ${isIndoor ? 'checked' : ''}>
                                <span class="track"></span>
                                <span class="thumb"></span>
                            </label>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
        
        <div class="rd-config-section">
            <h3 class="rd-config-title">🎨 Special Activities - Rainy Day Settings</h3>
            <p class="rd-config-desc">
                Mark activities as "Rainy Day Only" to make them exclusively available during rainy days.
                These activities will only appear in the scheduler when Rainy Day Mode is active.
            </p>
            
            <div class="rd-item-grid" id="rd-specials-grid">
                ${specials.length === 0 ? '<p style="color: #6b7280; font-style: italic; grid-column: 1/-1;">No special activities configured yet.</p>' : 
                specials.map(s => {
                    const isRainyOnly = s.rainyDayOnly === true;
                    return `
                        <div class="rd-item-row ${isRainyOnly ? 'rainy-only' : ''}">
                            <div>
                                <div class="rd-item-name">${s.name}</div>
                                ${isRainyOnly ? '<span class="rd-item-badge rd-badge-rainy">🌧️ Rainy Day Only</span>' : ''}
                            </div>
                            <label class="rd-mini-toggle">
                                <input type="checkbox" 
                                       data-special="${s.name}" 
                                       ${isRainyOnly ? 'checked' : ''}>
                                <span class="track"></span>
                                <span class="thumb"></span>
                            </label>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
        
        <div class="rd-summary-box">
            <div class="rd-summary-title">📊 Rainy Day Configuration Summary</div>
            <div class="rd-summary-stats">
                <div class="rd-summary-stat">
                    <span>🏠</span>
                    <strong>${fields.filter(f => f.rainyDayAvailable).length}</strong>
                    <span>Indoor Fields</span>
                </div>
                <div class="rd-summary-stat">
                    <span>🌳</span>
                    <strong>${fields.filter(f => !f.rainyDayAvailable).length}</strong>
                    <span>Outdoor Fields</span>
                </div>
                <div class="rd-summary-stat">
                    <span>🌧️</span>
                    <strong>${specials.filter(s => s.rainyDayOnly).length}</strong>
                    <span>Rainy Day Only Activities</span>
                </div>
            </div>
        </div>
    `;
    
    // Bind field toggles
    container.querySelectorAll('[data-field]').forEach(input => {
        input.addEventListener('change', function() {
            const fieldName = this.dataset.field;
            setFieldRainyDayStatus(fieldName, this.checked);
            createRainyDayConfigPanel(container);
        });
    });
    
    // Bind special activity toggles
    container.querySelectorAll('[data-special]').forEach(input => {
        input.addEventListener('change', function() {
            const specialName = this.dataset.special;
            setSpecialRainyDayStatus(specialName, { isRainyDayOnly: this.checked });
            createRainyDayConfigPanel(container);
        });
    });
}

// =============================================================
// EXPORTS
// =============================================================
window.RainyDayManager = {
    loadData: loadRainyDayData,
    
    // Field methods
    getFieldStatus: getFieldRainyDayStatus,
    setFieldStatus: setFieldRainyDayStatus,
    getAvailableFields: getRainyDayAvailableFields,
    getUnavailableFields: getRainyDayUnavailableFields,
    
    // Special activity methods
    getSpecialStatus: getSpecialRainyDayStatus,
    setSpecialStatus: setSpecialRainyDayStatus,
    getRainyDayOnlySpecials: getRainyDayOnlySpecials,
    getRainyDayAvailableSpecials: getRainyDayAvailableSpecials,
    
    // Mode control
    activate: activateRainyDayMode,
    activateMidDay: activateMidDayRainyMode,
    deactivate: deactivateRainyDayMode,
    isActive: isRainyDayActive,
    
    // Mid-day mode
    isMidDayMode: isMidDayModeActive,
    getMidDayStartTime: getMidDayRainyStartTime,
    setMidDayStartTime: setMidDayRainyStartTime,
    getPreservedSlots: getPreservedSlotIndices,
    shouldPreserveSlot: shouldPreserveSlot,
    backupPreservedSchedule: backupPreservedSchedule,
    restorePreservedSchedule: restorePreservedSchedule,
    
    // Skeleton management
    getRainyDaySkeletonName: getRainyDaySkeletonName,
    setRainyDaySkeletonName: setRainyDaySkeletonName,
    getAvailableSkeletons: getAvailableSkeletons,
    isAutoSkeletonSwitchEnabled: isAutoSkeletonSwitchEnabled,
    setAutoSkeletonSwitch: setAutoSkeletonSwitch,
    backupCurrentSkeleton: backupCurrentSkeleton,
    restorePreRainySkeleton: restorePreRainySkeleton,
    loadRainyDaySkeleton: loadRainyDaySkeleton,
    
    // Scheduler integration
    getEffectiveFieldAvailability: getEffectiveFieldAvailability,
    
    // UI Components
    createToggleUI: createRainyDayToggleUI,
    createConfigPanel: createRainyDayConfigPanel,
    
    // Utilities
    parseTimeToMinutes: parseTimeToMinutes,
    minutesToTime: minutesToTime,
    getCurrentTimeMinutes: getCurrentTimeMinutes
};

console.log("[RainyDay] Rainy Day Manager v2.1 loaded (with Auto-Skeleton, Mid-Day Mode & Cloud Sync)");

})();
