// ============================================================================
// rainy_day_manager.js — RAINY DAY MODE SYSTEM
// ============================================================================
// Professional rainy day scheduling with:
// - Field rain availability configuration
// - Rainy day special activities
// - One-click rainy day activation
// - Automatic schedule adjustments
// ============================================================================

(function() {
'use strict';

// =============================================================
// STATE
// =============================================================
let rainyDaySpecials = [];
let isRainyDayMode = false;

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
}

function saveRainyDayMode(enabled) {
    isRainyDayMode = enabled;
    window.saveCurrentDailyData?.("rainyDayMode", enabled);
}

function uid() {
    return "rain_" + Math.random().toString(36).substring(2, 10);
}

// =============================================================
// FIELD RAINY DAY HELPERS
// =============================================================
function getFieldRainyDayStatus(fieldName) {
    const g = window.loadGlobalSettings?.() || {};
    const fields = g.app1?.fields || [];
    const field = fields.find(f => f.name === fieldName);
    // Default: assume outdoor fields are NOT rainy day available
    return field?.rainyDayAvailable ?? false;
}

function setFieldRainyDayStatus(fieldName, available) {
    const g = window.loadGlobalSettings?.() || {};
    const fields = g.app1?.fields || [];
    const field = fields.find(f => f.name === fieldName);
    if (field) {
        field.rainyDayAvailable = available;
        window.saveGlobalSettings?.("app1", g.app1);
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
        availableOnRainyDay: special?.availableOnRainyDay ?? true // Default: specials ARE available on rainy days
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
// RAINY DAY MODE ACTIVATION LOGIC
// =============================================================
function activateRainyDayMode() {
    saveRainyDayMode(true);
    
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
    
    console.log(`[RainyDay] Activated! Disabled ${unavailableFields.length} outdoor fields.`);
    
    return {
        disabledFields: unavailableFields,
        availableFields: getRainyDayAvailableFields(),
        rainyDaySpecials: getRainyDayOnlySpecials().map(s => s.name)
    };
}

function deactivateRainyDayMode() {
    saveRainyDayMode(false);
    
    // Restore original disabled fields
    const dailyData = window.loadCurrentDailyData?.() || {};
    const preRainyDisabled = dailyData.preRainyDayDisabledFields || [];
    
    const overrides = dailyData.overrides || {};
    overrides.disabledFields = preRainyDisabled;
    window.saveCurrentDailyData?.("overrides", overrides);
    
    // Clear the stored pre-rainy state
    window.saveCurrentDailyData?.("preRainyDayDisabledFields", null);
    
    console.log(`[RainyDay] Deactivated! Restored normal field availability.`);
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
        return null; // Use normal availability
    }
    
    return {
        disabledFields: getRainyDayUnavailableFields(),
        additionalSpecials: getRainyDayOnlySpecials()
    };
}

// =============================================================
// UI COMPONENT: RAINY DAY TOGGLE
// =============================================================
function createRainyDayToggleUI(container, onToggle) {
    const isActive = isRainyDayActive();
    const availableFields = getRainyDayAvailableFields();
    const unavailableFields = getRainyDayUnavailableFields();
    const rainySpecials = getRainyDayOnlySpecials();
    
    const html = `
        <style>
            .rainy-day-card {
                border-radius: 16px;
                overflow: hidden;
                margin-bottom: 20px;
                transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
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
                grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
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
                font-size: 0.75rem;
                font-weight: 500;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                margin-bottom: 4px;
            }
            
            .rainy-day-card.inactive .rainy-stat-label { color: #94a3b8; }
            .rainy-day-card.active .rainy-stat-label { color: #7dd3fc; }
            
            .rainy-stat-value {
                font-size: 1.5rem;
                font-weight: 700;
            }
            
            .rainy-day-card.inactive .rainy-stat-value { color: #334155; }
            .rainy-day-card.active .rainy-stat-value { color: #f0f9ff; }
            
            .rainy-stat-detail {
                font-size: 0.8rem;
                margin-top: 2px;
            }
            
            .rainy-day-card.inactive .rainy-stat-detail { color: #64748b; }
            .rainy-day-card.active .rainy-stat-detail { color: #bae6fd; }
            
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
                            ${isActive ? 'Indoor schedule active' : 'Standard outdoor schedule'}
                        </p>
                    </div>
                </div>
                
                <div class="rainy-toggle-container">
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
                    <div class="rainy-stat-label">Rainy Day Activities</div>
                    <div class="rainy-stat-value">${rainySpecials.length}</div>
                    <div class="rainy-stat-detail">${isActive ? 'Activated' : 'On Standby'}</div>
                </div>
            </div>
        </div>
    `;
    
    container.innerHTML = html;
    
    // Bind toggle event
    const toggle = container.querySelector('#rainy-day-toggle');
    toggle.addEventListener('change', function() {
        const newState = this.checked;
        
        if (newState) {
            const result = activateRainyDayMode();
            showActivationNotification(true, result);
        } else {
            deactivateRainyDayMode();
            showActivationNotification(false);
        }
        
        // Re-render the UI
        createRainyDayToggleUI(container, onToggle);
        
        // Callback for parent component
        if (onToggle) onToggle(newState);
    });
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
    // Create notification element
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
    
    // Auto remove after 3 seconds
    setTimeout(() => {
        notif.style.animation = 'slideOut 0.3s ease-in forwards';
        setTimeout(() => notif.remove(), 300);
    }, 3000);
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
            // Refresh UI
            createRainyDayConfigPanel(container);
        });
    });
    
    // Bind special activity toggles
    container.querySelectorAll('[data-special]').forEach(input => {
        input.addEventListener('change', function() {
            const specialName = this.dataset.special;
            setSpecialRainyDayStatus(specialName, { isRainyDayOnly: this.checked });
            // Refresh UI
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
    deactivate: deactivateRainyDayMode,
    isActive: isRainyDayActive,
    
    // Scheduler integration
    getEffectiveFieldAvailability: getEffectiveFieldAvailability,
    
    // UI Components
    createToggleUI: createRainyDayToggleUI,
    createConfigPanel: createRainyDayConfigPanel
};

})();
