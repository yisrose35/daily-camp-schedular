// =================================================================
// print_center.js v3.0 — Visual Schedule Designer (Excel + Canva Hybrid)
// =================================================================
// FEATURES:
// - Live visual preview of generated schedules
// - Canva-like design toolbar (colors, fonts, logos, borders, headers)
// - Excel-like grid with customizable cells
// - Template save/load system with cloud sync
// - Per-camp branding (logo, colors, camp name)
// - RBAC: Owner/Admin can save templates; all roles can print
// - Division, Bunk, and Location views
// - Export to PDF-ready print, Excel
// =================================================================

(function() {
'use strict';

// --- VERSION ---
const VERSION = '3.0.0';
console.log(`🖨️ Print Center v${VERSION} loading...`);

// --- CONSTANTS ---
const INCREMENT_MINS = 30;
const DEFAULT_TEMPLATE = {
    id: 'default',
    name: 'Default Template',
    isDefault: true,
    // Header
    headerEnabled: true,
    campName: '',
    campLogo: null, // base64
    headerBgColor: '#147D91',
    headerTextColor: '#FFFFFF',
    headerFont: 'Inter',
    headerFontSize: 24,
    showDate: true,
    showDivisionName: true,
    customSubtitle: '',
    // Grid
    gridFont: 'Inter',
    gridFontSize: 11,
    gridHeaderBgColor: '#F1F5F9',
    gridHeaderTextColor: '#0F172A',
    gridBorderColor: '#CBD5E1',
    gridBorderWidth: 1,
    gridRowAltColor: '#F8FAFC',
    gridRowColor: '#FFFFFF',
    // Cell Colors by Type
    pinnedBgColor: '#FFF8E1',
    pinnedTextColor: '#92400E',
    leagueBgColor: '#E8F4FF',
    leagueTextColor: '#1E40AF',
    generalBgColor: '#FFFFFF',
    generalTextColor: '#1E293B',
    freeBgColor: '#F9FAFB',
    freeTextColor: '#9CA3AF',
    // Time Column
    timeColWidth: 130,
    timeColBgColor: '#F8FAFC',
    timeColTextColor: '#475569',
    timeColFont: 'Inter',
    timeColFontSize: 11,
    timeColBold: true,
    // Layout
    orientation: 'landscape', // landscape | portrait
    paperSize: 'letter', // letter | a4 | legal
    padding: 20,
    showPageBreaks: true,
    cellPadding: 8,
    // Watermark
    watermarkEnabled: false,
    watermarkText: '',
    watermarkOpacity: 0.08,
    watermarkColor: '#000000',
    // Footer
    footerEnabled: false,
    footerText: '',
    footerFont: 'Inter',
    footerFontSize: 9,
};

// --- STATE ---
let _currentTemplate = { ...DEFAULT_TEMPLATE };
let _savedTemplates = [];
let _activeView = 'division'; // division | bunk | location
let _selectedItems = [];
let _previewHtml = '';
let _designPanelOpen = true;
let _cloudSyncTimeout = null;
const CLOUD_SYNC_DEBOUNCE = 800;

// =========================================================================
// TIME UTILITIES (from scheduler)
// =========================================================================

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
    if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
    if (mer) {
        if (hh === 12) hh = mer === "am" ? 0 : 12;
        else if (mer === "pm") hh += 12;
    }
    return hh * 60 + mm;
}

function minutesToTimeLabel(min) {
    let h = Math.floor(min / 60);
    let m = min % 60;
    let ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${m.toString().padStart(2, '0')} ${ap}`;
}

function findFirstSlotForTime(startMin, divName = null) {
    if (divName && window.divisionTimes && window.divisionTimes[divName]) {
        const times = window.divisionTimes[divName];
        for (let i = 0; i < times.length; i++) {
            const slot = times[i];
            const slotStart = slot.startMin !== undefined ? slot.startMin : (new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes());
            if (slotStart >= startMin && slotStart < startMin + INCREMENT_MINS) return i;
        }
        return -1;
    }
    const times = window.unifiedTimes || [];
    if (startMin === null || !times.length) return -1;
    for (let i = 0; i < times.length; i++) {
        const slot = times[i];
        const slotStart = new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes();
        if (slotStart >= startMin && slotStart < startMin + INCREMENT_MINS) return i;
    }
    return -1;
}

function getEntry(bunk, slotIndex) {
    const dailyData = window.loadCurrentDailyData?.() || {};
    const assignments = dailyData.scheduleAssignments || window.scheduleAssignments || {};
    if (bunk && assignments[bunk] && assignments[bunk][slotIndex]) {
        return assignments[bunk][slotIndex];
    }
    return null;
}

function formatEntry(entry) {
    if (!entry) return "";
    if (entry._isDismissal) return "Dismissal";
    if (entry._isSnack) return "Snacks";
    let label = "";
    if (typeof entry.field === 'string') label = entry.field;
    else if (entry.field && entry.field.name) label = entry.field.name;
    if (entry._h2h) return entry.sport || "League Game";
    if (entry._fixed) return label || entry._activity || "";
    if (entry.sport) return `${label} – ${entry.sport}`;
    return label;
}

function naturalSort(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

// =========================================================================
// TEMPLATE PERSISTENCE (localStorage + Cloud)
// =========================================================================

function loadTemplates() {
    try {
        // 1. Try from global settings (cloud-synced)
        const g = window.loadGlobalSettings?.() || {};
        if (g.printTemplates && Array.isArray(g.printTemplates) && g.printTemplates.length > 0) {
            _savedTemplates = g.printTemplates;
            console.log(`🖨️ Loaded ${_savedTemplates.length} templates from cloud`);
            return;
        }
        // 2. Fallback localStorage
        const raw = localStorage.getItem('campistry_print_templates');
        if (raw) {
            _savedTemplates = JSON.parse(raw);
            console.log(`🖨️ Loaded ${_savedTemplates.length} templates from localStorage`);
            return;
        }
    } catch (e) {
        console.warn('🖨️ Template load error:', e);
    }
    _savedTemplates = [];
}

function saveTemplates() {
    // RBAC: Only owner/admin can save templates
    if (!canEditTemplates()) {
        console.warn('🖨️ Save blocked - insufficient permissions');
        if (typeof window.showToast === 'function') {
            window.showToast('Only owners and admins can save print templates', 'warning');
        }
        return false;
    }

    try {
        // localStorage
        localStorage.setItem('campistry_print_templates', JSON.stringify(_savedTemplates));
        
        // Cloud sync via saveGlobalSettings
        window.saveGlobalSettings?.("printTemplates", _savedTemplates);
        
        // Schedule debounced cloud push
        scheduleCloudSync();
        
        console.log(`🖨️ Saved ${_savedTemplates.length} templates`);
        return true;
    } catch (e) {
        console.error('🖨️ Template save error:', e);
        return false;
    }
}

function scheduleCloudSync() {
    clearTimeout(_cloudSyncTimeout);
    _cloudSyncTimeout = setTimeout(() => {
        if (typeof window.forceSyncToCloud === 'function') {
            console.log("🖨️☁️ Syncing print templates to cloud...");
            window.forceSyncToCloud();
        }
    }, CLOUD_SYNC_DEBOUNCE);
}

function saveCurrentAsTemplate(name) {
    if (!canEditTemplates()) return false;
    
    const template = {
        ...JSON.parse(JSON.stringify(_currentTemplate)),
        id: 'tpl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        name: name || 'Untitled Template',
        isDefault: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    
    _savedTemplates.push(template);
    saveTemplates();
    return template;
}

function updateTemplate(templateId) {
    if (!canEditTemplates()) return false;
    
    const idx = _savedTemplates.findIndex(t => t.id === templateId);
    if (idx === -1) return false;
    
    _savedTemplates[idx] = {
        ...JSON.parse(JSON.stringify(_currentTemplate)),
        id: templateId,
        name: _savedTemplates[idx].name,
        isDefault: false,
        createdAt: _savedTemplates[idx].createdAt,
        updatedAt: new Date().toISOString()
    };
    saveTemplates();
    return true;
}

function deleteTemplate(templateId) {
    if (!canEditTemplates()) return false;
    _savedTemplates = _savedTemplates.filter(t => t.id !== templateId);
    saveTemplates();
    return true;
}

function loadTemplate(templateId) {
    if (templateId === 'default') {
        _currentTemplate = { ...DEFAULT_TEMPLATE };
    } else {
        const tpl = _savedTemplates.find(t => t.id === templateId);
        if (tpl) {
            _currentTemplate = { ...DEFAULT_TEMPLATE, ...JSON.parse(JSON.stringify(tpl)) };
        }
    }
    refreshPreview();
    renderDesignPanel();
}

// =========================================================================
// RBAC HELPERS
// =========================================================================

function canEditTemplates() {
    // Owner/Admin can edit templates
    if (window.AccessControl?.isOwner?.()) return true;
    if (window.AccessControl?.isAdmin?.()) return true;
    
    // Fallback
    const role = window.CloudPermissions?.getRole?.() || 
                 window.CampistryDB?.getRole?.() ||
                 localStorage.getItem('campistry_role') || 'viewer';
    return role === 'owner' || role === 'admin';
}

function canPrint() {
    // Everyone can print (per existing RBAC rules)
    return true;
}

// =========================================================================
// MAIN INIT
// =========================================================================

function initPrintCenter() {
    const container = document.getElementById("print-content");
    if (!container) return;

    console.log(`🖨️ Initializing Print Center v${VERSION}`);
    
    // Load saved templates
    loadTemplates();
    
    // Load last-used template or default
    const lastTemplateId = localStorage.getItem('campistry_last_print_template');
    if (lastTemplateId && lastTemplateId !== 'default') {
        const tpl = _savedTemplates.find(t => t.id === lastTemplateId);
        if (tpl) _currentTemplate = { ...DEFAULT_TEMPLATE, ...JSON.parse(JSON.stringify(tpl)) };
    }
    
    // Auto-fill camp name from settings if not set
    if (!_currentTemplate.campName) {
        const g = window.loadGlobalSettings?.() || {};
        _currentTemplate.campName = g.campName || g.app1?.campName || '';
    }

    container.innerHTML = buildMainUI();
    
    // Bind events
    bindViewSwitcher();
    bindSelectors();
    bindDesignPanel();
    bindTemplateActions();
    bindActionButtons();
    
    // Initial preview
    populateSelectors();
    refreshPreview();
}

// =========================================================================
// MAIN UI LAYOUT
// =========================================================================

function buildMainUI() {
    const isEditor = canEditTemplates();
    
    return `
        <div class="pc-container">
            <!-- TOP BAR -->
            <div class="pc-topbar no-print">
                <div class="pc-topbar-left">
                    <h1 class="pc-title">🖨️ Print Center</h1>
                    <span class="pc-subtitle">Design & print personalized schedules</span>
                </div>
                <div class="pc-topbar-right">
                    ${isEditor ? `
                    <button class="pc-btn pc-btn-ghost" onclick="window._pcToggleDesignPanel()">
                        🎨 <span id="pc-design-toggle-text">Design</span>
                    </button>
                    ` : ''}
                    <button class="pc-btn pc-btn-secondary" onclick="window._pcExportExcel()">📊 Export Excel</button>
                    <button class="pc-btn pc-btn-primary" onclick="window._pcPrint()">🖨️ Print</button>
                </div>
            </div>

            <!-- VIEW SWITCHER + SELECTORS -->
            <div class="pc-controls no-print">
                <div class="pc-view-tabs">
                    <button class="pc-view-tab active" data-view="division">📅 Divisions</button>
                    <button class="pc-view-tab" data-view="bunk">👤 Bunks</button>
                    <button class="pc-view-tab" data-view="location">📍 Locations</button>
                </div>
                <div class="pc-selector-row">
                    <div class="pc-selector-box" id="pc-selector-container"></div>
                    <div class="pc-selector-actions">
                        <button class="pc-btn pc-btn-sm" onclick="window._pcSelectAll()">Select All</button>
                        <button class="pc-btn pc-btn-sm pc-btn-ghost" onclick="window._pcDeselectAll()">Clear</button>
                        <button class="pc-btn pc-btn-sm pc-btn-primary" onclick="window._pcRefreshPreview()">👁️ Preview</button>
                    </div>
                </div>
            </div>

            <!-- MAIN WORKSPACE -->
            <div class="pc-workspace">
                <!-- DESIGN PANEL (LEFT) -->
                <aside class="pc-design-panel no-print ${_designPanelOpen && isEditor ? 'open' : ''}" id="pc-design-panel">
                    <div class="pc-dp-scroll">
                        <!-- Template Selector -->
                        <div class="pc-dp-section">
                            <h3 class="pc-dp-heading">📋 Templates</h3>
                            <select id="pc-template-select" class="pc-dp-select" onchange="window._pcLoadTemplate(this.value)">
                                <option value="default">Default Template</option>
                            </select>
                            <div class="pc-dp-template-actions">
                                <button class="pc-btn pc-btn-xs pc-btn-primary" onclick="window._pcSaveAsTemplate()">Save As New</button>
                                <button class="pc-btn pc-btn-xs" onclick="window._pcUpdateTemplate()" id="pc-btn-update-tpl" style="display:none;">Update</button>
                                <button class="pc-btn pc-btn-xs pc-btn-danger" onclick="window._pcDeleteTemplate()" id="pc-btn-delete-tpl" style="display:none;">Delete</button>
                            </div>
                        </div>

                        <!-- Header Design -->
                        <div class="pc-dp-section">
                            <h3 class="pc-dp-heading">🏕️ Header & Branding</h3>
                            <label class="pc-dp-toggle">
                                <input type="checkbox" id="pc-header-enabled" ${_currentTemplate.headerEnabled ? 'checked' : ''}>
                                Show Header
                            </label>
                            <div class="pc-dp-field">
                                <label>Camp Name</label>
                                <input type="text" id="pc-camp-name" value="${escHtml(_currentTemplate.campName)}" placeholder="Your Camp Name">
                            </div>
                            <div class="pc-dp-field">
                                <label>Logo</label>
                                <div class="pc-logo-upload">
                                    <button class="pc-btn pc-btn-xs" onclick="document.getElementById('pc-logo-input').click()">Upload Logo</button>
                                    <button class="pc-btn pc-btn-xs pc-btn-ghost" onclick="window._pcRemoveLogo()" id="pc-remove-logo" style="display:${_currentTemplate.campLogo ? 'inline-block' : 'none'};">Remove</button>
                                    <input type="file" id="pc-logo-input" accept="image/*" style="display:none" onchange="window._pcHandleLogo(this)">
                                </div>
                                ${_currentTemplate.campLogo ? `<img src="${_currentTemplate.campLogo}" class="pc-logo-preview" alt="Logo">` : ''}
                            </div>
                            <div class="pc-dp-field">
                                <label>Custom Subtitle</label>
                                <input type="text" id="pc-custom-subtitle" value="${escHtml(_currentTemplate.customSubtitle)}" placeholder="e.g. Week 3 - Color War">
                            </div>
                            <div class="pc-dp-row">
                                <div class="pc-dp-field pc-dp-half">
                                    <label>Header BG</label>
                                    <input type="color" id="pc-header-bg" value="${_currentTemplate.headerBgColor}">
                                </div>
                                <div class="pc-dp-field pc-dp-half">
                                    <label>Header Text</label>
                                    <input type="color" id="pc-header-text" value="${_currentTemplate.headerTextColor}">
                                </div>
                            </div>
                            <div class="pc-dp-row">
                                <div class="pc-dp-field pc-dp-half">
                                    <label>Font</label>
                                    <select id="pc-header-font">
                                        ${fontOptions(_currentTemplate.headerFont)}
                                    </select>
                                </div>
                                <div class="pc-dp-field pc-dp-half">
                                    <label>Size</label>
                                    <input type="number" id="pc-header-font-size" value="${_currentTemplate.headerFontSize}" min="12" max="48">
                                </div>
                            </div>
                            <label class="pc-dp-toggle">
                                <input type="checkbox" id="pc-show-date" ${_currentTemplate.showDate ? 'checked' : ''}>
                                Show Date
                            </label>
                            <label class="pc-dp-toggle">
                                <input type="checkbox" id="pc-show-div-name" ${_currentTemplate.showDivisionName ? 'checked' : ''}>
                                Show Division/Bunk Name
                            </label>
                        </div>

                        <!-- Grid Design -->
                        <div class="pc-dp-section">
                            <h3 class="pc-dp-heading">📊 Grid Styling</h3>
                            <div class="pc-dp-row">
                                <div class="pc-dp-field pc-dp-half">
                                    <label>Font</label>
                                    <select id="pc-grid-font">
                                        ${fontOptions(_currentTemplate.gridFont)}
                                    </select>
                                </div>
                                <div class="pc-dp-field pc-dp-half">
                                    <label>Size</label>
                                    <input type="number" id="pc-grid-font-size" value="${_currentTemplate.gridFontSize}" min="8" max="18">
                                </div>
                            </div>
                            <div class="pc-dp-row">
                                <div class="pc-dp-field pc-dp-half">
                                    <label>Header BG</label>
                                    <input type="color" id="pc-grid-header-bg" value="${_currentTemplate.gridHeaderBgColor}">
                                </div>
                                <div class="pc-dp-field pc-dp-half">
                                    <label>Header Text</label>
                                    <input type="color" id="pc-grid-header-text" value="${_currentTemplate.gridHeaderTextColor}">
                                </div>
                            </div>
                            <div class="pc-dp-row">
                                <div class="pc-dp-field pc-dp-half">
                                    <label>Border Color</label>
                                    <input type="color" id="pc-grid-border-color" value="${_currentTemplate.gridBorderColor}">
                                </div>
                                <div class="pc-dp-field pc-dp-half">
                                    <label>Border Width</label>
                                    <input type="number" id="pc-grid-border-width" value="${_currentTemplate.gridBorderWidth}" min="0" max="4">
                                </div>
                            </div>
                            <div class="pc-dp-row">
                                <div class="pc-dp-field pc-dp-half">
                                    <label>Row Color</label>
                                    <input type="color" id="pc-grid-row-color" value="${_currentTemplate.gridRowColor}">
                                </div>
                                <div class="pc-dp-field pc-dp-half">
                                    <label>Alt Row</label>
                                    <input type="color" id="pc-grid-row-alt" value="${_currentTemplate.gridRowAltColor}">
                                </div>
                            </div>
                            <div class="pc-dp-field">
                                <label>Cell Padding (px)</label>
                                <input type="range" id="pc-cell-padding" min="2" max="20" value="${_currentTemplate.cellPadding}">
                            </div>
                        </div>

                        <!-- Cell Colors -->
                        <div class="pc-dp-section">
                            <h3 class="pc-dp-heading">🎨 Activity Colors</h3>
                            <div class="pc-dp-color-grid">
                                <div class="pc-dp-color-pair">
                                    <span>General</span>
                                    <input type="color" id="pc-general-bg" value="${_currentTemplate.generalBgColor}">
                                    <input type="color" id="pc-general-text" value="${_currentTemplate.generalTextColor}">
                                </div>
                                <div class="pc-dp-color-pair">
                                    <span>Pinned</span>
                                    <input type="color" id="pc-pinned-bg" value="${_currentTemplate.pinnedBgColor}">
                                    <input type="color" id="pc-pinned-text" value="${_currentTemplate.pinnedTextColor}">
                                </div>
                                <div class="pc-dp-color-pair">
                                    <span>League</span>
                                    <input type="color" id="pc-league-bg" value="${_currentTemplate.leagueBgColor}">
                                    <input type="color" id="pc-league-text" value="${_currentTemplate.leagueTextColor}">
                                </div>
                                <div class="pc-dp-color-pair">
                                    <span>Free</span>
                                    <input type="color" id="pc-free-bg" value="${_currentTemplate.freeBgColor}">
                                    <input type="color" id="pc-free-text" value="${_currentTemplate.freeTextColor}">
                                </div>
                            </div>
                        </div>

                        <!-- Time Column -->
                        <div class="pc-dp-section">
                            <h3 class="pc-dp-heading">⏰ Time Column</h3>
                            <div class="pc-dp-row">
                                <div class="pc-dp-field pc-dp-half">
                                    <label>BG Color</label>
                                    <input type="color" id="pc-time-bg" value="${_currentTemplate.timeColBgColor}">
                                </div>
                                <div class="pc-dp-field pc-dp-half">
                                    <label>Text Color</label>
                                    <input type="color" id="pc-time-text" value="${_currentTemplate.timeColTextColor}">
                                </div>
                            </div>
                            <div class="pc-dp-field">
                                <label>Width (px)</label>
                                <input type="number" id="pc-time-width" value="${_currentTemplate.timeColWidth}" min="80" max="200">
                            </div>
                            <label class="pc-dp-toggle">
                                <input type="checkbox" id="pc-time-bold" ${_currentTemplate.timeColBold ? 'checked' : ''}>
                                Bold Times
                            </label>
                        </div>

                        <!-- Layout -->
                        <div class="pc-dp-section">
                            <h3 class="pc-dp-heading">📐 Layout</h3>
                            <div class="pc-dp-field">
                                <label>Orientation</label>
                                <select id="pc-orientation">
                                    <option value="landscape" ${_currentTemplate.orientation === 'landscape' ? 'selected' : ''}>Landscape</option>
                                    <option value="portrait" ${_currentTemplate.orientation === 'portrait' ? 'selected' : ''}>Portrait</option>
                                </select>
                            </div>
                            <div class="pc-dp-field">
                                <label>Paper Size</label>
                                <select id="pc-paper-size">
                                    <option value="letter" ${_currentTemplate.paperSize === 'letter' ? 'selected' : ''}>Letter (8.5 x 11)</option>
                                    <option value="a4" ${_currentTemplate.paperSize === 'a4' ? 'selected' : ''}>A4</option>
                                    <option value="legal" ${_currentTemplate.paperSize === 'legal' ? 'selected' : ''}>Legal (8.5 x 14)</option>
                                </select>
                            </div>
                            <label class="pc-dp-toggle">
                                <input type="checkbox" id="pc-page-breaks" ${_currentTemplate.showPageBreaks ? 'checked' : ''}>
                                Page breaks between items
                            </label>
                        </div>

                        <!-- Watermark -->
                        <div class="pc-dp-section">
                            <h3 class="pc-dp-heading">💧 Watermark</h3>
                            <label class="pc-dp-toggle">
                                <input type="checkbox" id="pc-watermark-enabled" ${_currentTemplate.watermarkEnabled ? 'checked' : ''}>
                                Enable Watermark
                            </label>
                            <div class="pc-dp-field">
                                <label>Text</label>
                                <input type="text" id="pc-watermark-text" value="${escHtml(_currentTemplate.watermarkText)}" placeholder="e.g. DRAFT">
                            </div>
                            <div class="pc-dp-row">
                                <div class="pc-dp-field pc-dp-half">
                                    <label>Color</label>
                                    <input type="color" id="pc-watermark-color" value="${_currentTemplate.watermarkColor}">
                                </div>
                                <div class="pc-dp-field pc-dp-half">
                                    <label>Opacity</label>
                                    <input type="range" id="pc-watermark-opacity" min="0.02" max="0.3" step="0.01" value="${_currentTemplate.watermarkOpacity}">
                                </div>
                            </div>
                        </div>

                        <!-- Footer -->
                        <div class="pc-dp-section">
                            <h3 class="pc-dp-heading">📝 Footer</h3>
                            <label class="pc-dp-toggle">
                                <input type="checkbox" id="pc-footer-enabled" ${_currentTemplate.footerEnabled ? 'checked' : ''}>
                                Enable Footer
                            </label>
                            <div class="pc-dp-field">
                                <label>Footer Text</label>
                                <input type="text" id="pc-footer-text" value="${escHtml(_currentTemplate.footerText)}" placeholder="e.g. Confidential - Do Not Distribute">
                            </div>
                        </div>

                        <!-- Reset -->
                        <div class="pc-dp-section">
                            <button class="pc-btn pc-btn-ghost" style="width:100%;" onclick="window._pcResetToDefault()">↩️ Reset to Default</button>
                        </div>
                    </div>
                </aside>

                <!-- PREVIEW AREA (RIGHT) -->
                <div class="pc-preview-area" id="pc-preview-area">
                    <div class="pc-preview-empty" id="pc-preview-empty">
                        <div class="pc-preview-empty-icon">📋</div>
                        <h3>Select items and click Preview</h3>
                        <p>Choose divisions, bunks, or locations from above, then click "👁️ Preview" to see your styled schedule.</p>
                    </div>
                    <div id="pc-preview-content" class="pc-preview-content" style="display:none;"></div>
                </div>
            </div>

            <!-- HIDDEN PRINTABLE AREA -->
            <div id="printable-area"></div>
        </div>
    `;
}

// =========================================================================
// FONT OPTIONS HELPER
// =========================================================================

function fontOptions(selected) {
    const fonts = [
        'Inter', 'Arial', 'Helvetica', 'Georgia', 'Times New Roman',
        'Courier New', 'Verdana', 'Trebuchet MS', 'Palatino', 'Garamond',
        'Comic Sans MS', 'Impact'
    ];
    return fonts.map(f => `<option value="${f}" ${f === selected ? 'selected' : ''}>${f}</option>`).join('');
}

function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// =========================================================================
// EVENT BINDING
// =========================================================================

function bindViewSwitcher() {
    document.querySelectorAll('.pc-view-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.pc-view-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _activeView = btn.dataset.view;
            _selectedItems = [];
            populateSelectors();
        });
    });
}

function bindSelectors() {
    // Handled dynamically via populateSelectors
}

function bindDesignPanel() {
    // Listen to all design inputs for live preview update
    const debouncedRefresh = debounce(() => {
        readDesignValues();
        refreshPreview();
    }, 250);

    // Use event delegation on design panel
    const panel = document.getElementById('pc-design-panel');
    if (!panel) return;

    panel.addEventListener('input', (e) => {
        if (e.target.matches('input, select')) {
            debouncedRefresh();
        }
    });
    panel.addEventListener('change', (e) => {
        if (e.target.matches('input, select')) {
            readDesignValues();
            refreshPreview();
        }
    });
}

function bindTemplateActions() {
    renderTemplateDropdown();
}

function bindActionButtons() {
    // Already bound via onclick in HTML
}

// =========================================================================
// POPULATE SELECTORS
// =========================================================================

function populateSelectors() {
    const container = document.getElementById('pc-selector-container');
    if (!container) return;

    const app1 = window.loadGlobalSettings?.().app1 || {};
    const divisions = app1.divisions || {};
    const availableDivisions = app1.availableDivisions || [];
    const fields = app1.fields || [];
    const specials = app1.specialActivities || [];

    let html = '';

    if (_activeView === 'division') {
        availableDivisions.forEach(divName => {
            html += `<label class="pc-selector-item"><input type="checkbox" value="${escHtml(divName)}" class="pc-item-cb"> ${escHtml(divName)}</label>`;
        });
    } else if (_activeView === 'bunk') {
        availableDivisions.forEach(divName => {
            const bunks = (divisions[divName]?.bunks || []).sort(naturalSort);
            if (bunks.length > 0) {
                html += `<div class="pc-selector-group">${escHtml(divName)}</div>`;
                bunks.forEach(b => {
                    html += `<label class="pc-selector-item"><input type="checkbox" value="${escHtml(b)}" class="pc-item-cb"> ${escHtml(b)}</label>`;
                });
            }
        });
    } else if (_activeView === 'location') {
        const allLocs = [...fields.map(f => f.name), ...specials.map(s => s.name)].sort(naturalSort);
        allLocs.forEach(loc => {
            html += `<label class="pc-selector-item"><input type="checkbox" value="${escHtml(loc)}" class="pc-item-cb"> ${escHtml(loc)}</label>`;
        });
    }

    container.innerHTML = html;
}

function getSelectedItems() {
    return Array.from(document.querySelectorAll('.pc-item-cb:checked')).map(cb => cb.value);
}

// =========================================================================
// READ DESIGN VALUES FROM UI
// =========================================================================

function readDesignValues() {
    const t = _currentTemplate;

    // Header
    t.headerEnabled = !!document.getElementById('pc-header-enabled')?.checked;
    t.campName = document.getElementById('pc-camp-name')?.value || '';
    t.customSubtitle = document.getElementById('pc-custom-subtitle')?.value || '';
    t.headerBgColor = document.getElementById('pc-header-bg')?.value || t.headerBgColor;
    t.headerTextColor = document.getElementById('pc-header-text')?.value || t.headerTextColor;
    t.headerFont = document.getElementById('pc-header-font')?.value || t.headerFont;
    t.headerFontSize = parseInt(document.getElementById('pc-header-font-size')?.value) || t.headerFontSize;
    t.showDate = !!document.getElementById('pc-show-date')?.checked;
    t.showDivisionName = !!document.getElementById('pc-show-div-name')?.checked;

    // Grid
    t.gridFont = document.getElementById('pc-grid-font')?.value || t.gridFont;
    t.gridFontSize = parseInt(document.getElementById('pc-grid-font-size')?.value) || t.gridFontSize;
    t.gridHeaderBgColor = document.getElementById('pc-grid-header-bg')?.value || t.gridHeaderBgColor;
    t.gridHeaderTextColor = document.getElementById('pc-grid-header-text')?.value || t.gridHeaderTextColor;
    t.gridBorderColor = document.getElementById('pc-grid-border-color')?.value || t.gridBorderColor;
    t.gridBorderWidth = parseInt(document.getElementById('pc-grid-border-width')?.value) || 1;
    t.gridRowColor = document.getElementById('pc-grid-row-color')?.value || t.gridRowColor;
    t.gridRowAltColor = document.getElementById('pc-grid-row-alt')?.value || t.gridRowAltColor;
    t.cellPadding = parseInt(document.getElementById('pc-cell-padding')?.value) || 8;

    // Cell Colors
    t.generalBgColor = document.getElementById('pc-general-bg')?.value || t.generalBgColor;
    t.generalTextColor = document.getElementById('pc-general-text')?.value || t.generalTextColor;
    t.pinnedBgColor = document.getElementById('pc-pinned-bg')?.value || t.pinnedBgColor;
    t.pinnedTextColor = document.getElementById('pc-pinned-text')?.value || t.pinnedTextColor;
    t.leagueBgColor = document.getElementById('pc-league-bg')?.value || t.leagueBgColor;
    t.leagueTextColor = document.getElementById('pc-league-text')?.value || t.leagueTextColor;
    t.freeBgColor = document.getElementById('pc-free-bg')?.value || t.freeBgColor;
    t.freeTextColor = document.getElementById('pc-free-text')?.value || t.freeTextColor;

    // Time Column
    t.timeColBgColor = document.getElementById('pc-time-bg')?.value || t.timeColBgColor;
    t.timeColTextColor = document.getElementById('pc-time-text')?.value || t.timeColTextColor;
    t.timeColWidth = parseInt(document.getElementById('pc-time-width')?.value) || 130;
    t.timeColBold = !!document.getElementById('pc-time-bold')?.checked;

    // Layout
    t.orientation = document.getElementById('pc-orientation')?.value || 'landscape';
    t.paperSize = document.getElementById('pc-paper-size')?.value || 'letter';
    t.showPageBreaks = !!document.getElementById('pc-page-breaks')?.checked;

    // Watermark
    t.watermarkEnabled = !!document.getElementById('pc-watermark-enabled')?.checked;
    t.watermarkText = document.getElementById('pc-watermark-text')?.value || '';
    t.watermarkColor = document.getElementById('pc-watermark-color')?.value || '#000000';
    t.watermarkOpacity = parseFloat(document.getElementById('pc-watermark-opacity')?.value) || 0.08;

    // Footer
    t.footerEnabled = !!document.getElementById('pc-footer-enabled')?.checked;
    t.footerText = document.getElementById('pc-footer-text')?.value || '';
}

// =========================================================================
// RENDER DESIGN PANEL (template dropdown refresh)
// =========================================================================

function renderDesignPanel() {
    renderTemplateDropdown();
}

function renderTemplateDropdown() {
    const select = document.getElementById('pc-template-select');
    if (!select) return;

    const currentId = _currentTemplate.id || 'default';
    let html = `<option value="default" ${currentId === 'default' ? 'selected' : ''}>Default Template</option>`;
    _savedTemplates.forEach(tpl => {
        html += `<option value="${tpl.id}" ${currentId === tpl.id ? 'selected' : ''}>${escHtml(tpl.name)}</option>`;
    });
    select.innerHTML = html;

    // Show/hide update/delete buttons
    const isCustom = currentId !== 'default';
    const updateBtn = document.getElementById('pc-btn-update-tpl');
    const deleteBtn = document.getElementById('pc-btn-delete-tpl');
    if (updateBtn) updateBtn.style.display = isCustom && canEditTemplates() ? 'inline-block' : 'none';
    if (deleteBtn) deleteBtn.style.display = isCustom && canEditTemplates() ? 'inline-block' : 'none';
}

// =========================================================================
// STYLED HTML GENERATORS
// =========================================================================

function buildStyledHeader(titleText) {
    const t = _currentTemplate;
    if (!t.headerEnabled) return '';

    let header = `<div style="
        background: ${t.headerBgColor};
        color: ${t.headerTextColor};
        font-family: '${t.headerFont}', sans-serif;
        padding: 16px 24px;
        display: flex;
        align-items: center;
        gap: 16px;
        border-radius: 8px 8px 0 0;
    ">`;

    if (t.campLogo) {
        header += `<img src="${t.campLogo}" style="height: ${t.headerFontSize + 20}px; max-width: 120px; object-fit: contain; border-radius: 4px;" alt="Logo">`;
    }

    header += `<div style="flex:1;">`;
    if (t.campName) {
        header += `<div style="font-size: ${t.headerFontSize}px; font-weight: 700; letter-spacing: -0.02em;">${escHtml(t.campName)}</div>`;
    }
    if (t.showDivisionName && titleText) {
        header += `<div style="font-size: ${Math.max(12, t.headerFontSize - 6)}px; opacity: 0.9; margin-top: 2px;">${escHtml(titleText)}</div>`;
    }
    if (t.customSubtitle) {
        header += `<div style="font-size: ${Math.max(10, t.headerFontSize - 10)}px; opacity: 0.75; margin-top: 2px;">${escHtml(t.customSubtitle)}</div>`;
    }
    header += `</div>`;

    if (t.showDate) {
        header += `<div style="font-size: ${Math.max(11, t.headerFontSize - 8)}px; opacity: 0.85; text-align: right; white-space: nowrap;">
            ${formatDisplayDate(window.currentScheduleDate)}
        </div>`;
    }

    header += `</div>`;
    return header;
}

function formatDisplayDate(dateStr) {
    if (!dateStr) return '';
    try {
        const d = new Date(dateStr + 'T12:00:00');
        return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    } catch (e) {
        return dateStr;
    }
}

function buildStyledFooter() {
    const t = _currentTemplate;
    if (!t.footerEnabled || !t.footerText) return '';
    return `<div style="
        font-family: '${t.footerFont}', sans-serif;
        font-size: ${t.footerFontSize}px;
        color: #94A3B8;
        text-align: center;
        padding: 8px 16px;
        border-top: 1px solid ${t.gridBorderColor};
    ">${escHtml(t.footerText)}</div>`;
}

function buildWatermark() {
    const t = _currentTemplate;
    if (!t.watermarkEnabled || !t.watermarkText) return '';
    return `<div style="
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%) rotate(-35deg);
        font-size: 72px;
        font-weight: 900;
        color: ${t.watermarkColor};
        opacity: ${t.watermarkOpacity};
        pointer-events: none;
        white-space: nowrap;
        z-index: 1;
        letter-spacing: 0.1em;
    ">${escHtml(t.watermarkText)}</div>`;
}

function cellStyle(type, isAltRow) {
    const t = _currentTemplate;
    let bg, color;
    switch (type) {
        case 'pinned': bg = t.pinnedBgColor; color = t.pinnedTextColor; break;
        case 'league': bg = t.leagueBgColor; color = t.leagueTextColor; break;
        case 'free':   bg = t.freeBgColor;   color = t.freeTextColor;   break;
        default:       bg = isAltRow ? t.gridRowAltColor : t.gridRowColor; color = t.generalTextColor;
    }
    return `background:${bg}; color:${color}; padding:${t.cellPadding}px; font-family:'${t.gridFont}',sans-serif; font-size:${t.gridFontSize}px; border:${t.gridBorderWidth}px solid ${t.gridBorderColor};`;
}

function timeStyle() {
    const t = _currentTemplate;
    return `background:${t.timeColBgColor}; color:${t.timeColTextColor}; font-family:'${t.timeColFont || t.gridFont}',sans-serif; font-size:${t.timeColFontSize || t.gridFontSize}px; font-weight:${t.timeColBold ? '700' : '400'}; padding:${t.cellPadding}px; border:${t.gridBorderWidth}px solid ${t.gridBorderColor}; width:${t.timeColWidth}px;`;
}

function headerCellStyle() {
    const t = _currentTemplate;
    return `background:${t.gridHeaderBgColor}; color:${t.gridHeaderTextColor}; font-family:'${t.gridFont}',sans-serif; font-size:${t.gridFontSize}px; font-weight:600; padding:${t.cellPadding}px; border:${t.gridBorderWidth}px solid ${t.gridBorderColor};`;
}

// =========================================================================
// DIVISION HTML GENERATOR (STYLED)
// =========================================================================

function generateStyledDivisionHTML(divName) {
    const t = _currentTemplate;
    const daily = window.loadCurrentDailyData?.() || {};
    const manualSkeleton = daily.manualSkeleton || [];
    const divisions = window.loadGlobalSettings?.().app1?.divisions || {};
    const bunks = (divisions[divName]?.bunks || []).sort(naturalSort);

    if (bunks.length === 0) return "";

    // Build blocks
    const tempSortedBlocks = [];
    manualSkeleton.forEach(item => {
        if (item.division === divName) {
            const startMin = parseTimeToMinutes(item.startTime);
            const endMin = parseTimeToMinutes(item.endTime);
            if (startMin === null || endMin === null) return;
            tempSortedBlocks.push({ item, startMin, endMin });
        }
    });
    tempSortedBlocks.sort((a, b) => a.startMin - b.startMin);

    const divisionBlocks = [];
    let leagueCounter = 0, specialtyCounter = 0;
    tempSortedBlocks.forEach(block => {
        let eventName = block.item.event;
        if (block.item.event === "League Game") { leagueCounter++; eventName = `League Game ${leagueCounter}`; }
        else if (block.item.event === "Specialty League") { specialtyCounter++; eventName = `Specialty League ${specialtyCounter}`; }
        divisionBlocks.push({
            label: `${minutesToTimeLabel(block.startMin)} - ${minutesToTimeLabel(block.endMin)}`,
            startMin: block.startMin, endMin: block.endMin,
            event: eventName, type: block.item.type
        });
    });

    const uniqueBlocks = divisionBlocks.filter((block, index, self) =>
        index === self.findIndex(t2 => t2.label === block.label)
    );

    const flattenedBlocks = [];
    uniqueBlocks.forEach(block => {
        if (block.type === "split" && block.startMin !== null && block.endMin !== null) {
            const midMin = Math.round(block.startMin + (block.endMin - block.startMin) / 2);
            flattenedBlocks.push({ ...block, label: `${minutesToTimeLabel(block.startMin)} - ${minutesToTimeLabel(midMin)}`, startMin: block.startMin, endMin: midMin, splitPart: 1 });
            flattenedBlocks.push({ ...block, label: `${minutesToTimeLabel(midMin)} - ${minutesToTimeLabel(block.endMin)}`, startMin: midMin, endMin: block.endMin, splitPart: 2 });
        } else {
            flattenedBlocks.push(block);
        }
    });

    // Build styled HTML
    let html = `<div class="pc-print-page" style="position:relative; page-break-after: ${t.showPageBreaks ? 'always' : 'auto'}; margin-bottom: 24px;">`;
    html += buildWatermark();
    html += buildStyledHeader(`${divName} Schedule`);

    html += `<table style="width:100%; border-collapse:collapse; font-family:'${t.gridFont}',sans-serif; font-size:${t.gridFontSize}px;">`;
    html += `<thead><tr>`;
    html += `<th style="${headerCellStyle()} width:${t.timeColWidth}px;">Time</th>`;
    bunks.forEach(b => { html += `<th style="${headerCellStyle()}">${escHtml(b)}</th>`; });
    html += `</tr></thead><tbody>`;

    if (flattenedBlocks.length === 0) {
        html += `<tr><td colspan="${bunks.length + 1}" style="text-align:center; padding:20px; color:#94A3B8;">No schedule blocks found for this date.</td></tr>`;
    }

    flattenedBlocks.forEach((eventBlock, rowIdx) => {
        const isAlt = rowIdx % 2 === 1;
        html += `<tr>`;
        html += `<td style="${timeStyle()}">${eventBlock.label}</td>`;

        const isLeague = eventBlock.event.startsWith("League Game") || eventBlock.event.startsWith("Specialty League");

        if (isLeague) {
            const firstSlotIndex = findFirstSlotForTime(eventBlock.startMin, divName);
            let allMatchups = [];
            if (bunks.length > 0) {
                const entry = getEntry(bunks[0], firstSlotIndex);
                if (entry && entry._allMatchups) allMatchups = entry._allMatchups;
            }
            let cellContent = `<strong>${escHtml(eventBlock.event)}</strong>`;
            if (allMatchups.length > 0) {
                cellContent += `<ul style="margin:4px 0 0 16px; padding:0; font-size:0.9em;">`;
                allMatchups.forEach(m => cellContent += `<li>${escHtml(m)}</li>`);
                cellContent += `</ul>`;
            }
            html += `<td colspan="${bunks.length}" style="${cellStyle('league', isAlt)} vertical-align:top;">${cellContent}</td>`;
        } else {
            bunks.forEach(bunk => {
                const slotIndex = findFirstSlotForTime(eventBlock.startMin, divName);
                const entry = getEntry(bunk, slotIndex);
                let text = "", type = 'general';

                if (entry) {
                    text = formatEntry(entry);
                    if (entry._fixed) type = 'pinned';
                    if (["Lunch","Snack","Dismissal","Swim"].some(k => (eventBlock.event || '').includes(k))) type = 'pinned';
                } else {
                    type = 'free';
                    text = '';
                }

                html += `<td style="${cellStyle(type, isAlt)}">${escHtml(text)}</td>`;
            });
        }
        html += `</tr>`;
    });

    html += `</tbody></table>`;
    html += buildStyledFooter();
    html += `</div>`;
    return html;
}

// =========================================================================
// BUNK HTML GENERATOR (STYLED)
// =========================================================================

function generateStyledBunkHTML(bunk) {
    const t = _currentTemplate;
    const daily = window.loadCurrentDailyData?.() || {};
    const schedule = daily.scheduleAssignments?.[bunk] || [];

    let divName = null;
    const divisions = window.loadGlobalSettings?.().app1?.divisions || {};
    for (const [dName, dData] of Object.entries(divisions)) {
        if (dData.bunks && dData.bunks.includes(bunk)) { divName = dName; break; }
    }

    const times = (divName && window.divisionTimes?.[divName]) || window.unifiedTimes || [];

    let html = `<div class="pc-print-page" style="position:relative; page-break-after: ${t.showPageBreaks ? 'always' : 'auto'}; margin-bottom: 24px;">`;
    html += buildWatermark();
    html += buildStyledHeader(`${bunk} Schedule${divName ? ` (${divName})` : ''}`);

    html += `<table style="width:100%; border-collapse:collapse; font-family:'${t.gridFont}',sans-serif; font-size:${t.gridFontSize}px;">`;
    html += `<thead><tr>`;
    html += `<th style="${headerCellStyle()} width:${t.timeColWidth}px;">Time</th>`;
    html += `<th style="${headerCellStyle()}">Activity / Location</th>`;
    html += `</tr></thead><tbody>`;

    times.forEach((slot, i) => {
        const entry = schedule[i];
        if (!entry || entry.continuation) return;

        const isAlt = i % 2 === 1;
        let label = "";
        if (typeof entry.field === 'object') label = entry.field?.name || '';
        else label = entry.field || '';

        let type = 'general';
        if (entry._fixed) type = 'pinned';
        if (entry._h2h) {
            type = 'league';
            if (entry._allMatchups && entry._allMatchups.length > 0) {
                label = `<strong>${escHtml(entry.sport || "League Game")}</strong>`;
                label += `<ul style="margin:4px 0 0 16px; padding:0; font-size:0.9em;">`;
                entry._allMatchups.forEach(m => {
                    const isMine = entry.sport && m === entry.sport;
                    label += `<li${isMine ? ' style="font-weight:700;"' : ''}>${escHtml(m)}</li>`;
                });
                label += `</ul>`;
            } else {
                label = `<strong>${escHtml(entry.sport || 'League Game')}</strong>`;
            }
        }
        if (!label && !entry._h2h) label = escHtml(formatEntry(entry));

        const timeLabel = slot.label || `${minutesToTimeLabel(slot.startMin || 0)} - ${minutesToTimeLabel(slot.endMin || 0)}`;

        html += `<tr>`;
        html += `<td style="${timeStyle()}">${timeLabel}</td>`;
        html += `<td style="${cellStyle(type, isAlt)}">${label}</td>`;
        html += `</tr>`;
    });

    if (times.length === 0) {
        html += `<tr><td colspan="2" style="text-align:center; padding:20px; color:#94A3B8;">No schedule data found.</td></tr>`;
    }

    html += `</tbody></table>`;
    html += buildStyledFooter();
    html += `</div>`;
    return html;
}

// =========================================================================
// LOCATION HTML GENERATOR (STYLED)
// =========================================================================

function generateStyledLocationHTML(loc) {
    const t = _currentTemplate;
    const daily = window.loadCurrentDailyData?.() || {};
    const times = window.unifiedTimes || [];
    const assignments = daily.scheduleAssignments || {};

    let html = `<div class="pc-print-page" style="position:relative; page-break-after: ${t.showPageBreaks ? 'always' : 'auto'}; margin-bottom: 24px;">`;
    html += buildWatermark();
    html += buildStyledHeader(`${loc} Schedule`);

    html += `<table style="width:100%; border-collapse:collapse; font-family:'${t.gridFont}',sans-serif; font-size:${t.gridFontSize}px;">`;
    html += `<thead><tr>`;
    html += `<th style="${headerCellStyle()} width:${t.timeColWidth}px;">Time</th>`;
    html += `<th style="${headerCellStyle()}">Event / Bunks</th>`;
    html += `</tr></thead><tbody>`;

    times.forEach((slot, i) => {
        const isAlt = i % 2 === 1;
        const bunksHere = [];
        let leagueLabel = null;

        Object.keys(assignments).forEach(b => {
            const entry = assignments[b][i];
            if (entry) {
                const fName = (typeof entry.field === 'object') ? entry.field?.name : entry.field;
                if (fName === loc) {
                    if (!bunksHere.includes(b)) bunksHere.push(b);
                    if (entry._h2h && entry.sport) {
                        let matchStr = entry.sport;
                        if (matchStr.includes('@')) matchStr = matchStr.split('@')[0].trim();
                        leagueLabel = matchStr;
                    }
                }
            }
        });

        let content = "", type = 'general';
        if (leagueLabel) {
            content = `<strong>${escHtml(leagueLabel)}</strong>`;
            type = 'league';
        } else if (bunksHere.length > 0) {
            content = bunksHere.map(b => escHtml(b)).join(", ");
        } else {
            content = "— Free —";
            type = 'free';
        }

        html += `<tr>`;
        html += `<td style="${timeStyle()}">${slot.label || ''}</td>`;
        html += `<td style="${cellStyle(type, isAlt)}">${content}</td>`;
        html += `</tr>`;
    });

    html += `</tbody></table>`;
    html += buildStyledFooter();
    html += `</div>`;
    return html;
}

// =========================================================================
// PREVIEW REFRESH
// =========================================================================

function refreshPreview() {
    const selected = getSelectedItems();
    const previewContent = document.getElementById('pc-preview-content');
    const previewEmpty = document.getElementById('pc-preview-empty');

    if (!previewContent) return;

    if (selected.length === 0) {
        previewContent.style.display = 'none';
        if (previewEmpty) previewEmpty.style.display = 'flex';
        return;
    }

    previewContent.style.display = 'block';
    if (previewEmpty) previewEmpty.style.display = 'none';

    let html = '';
    if (_activeView === 'division') {
        selected.forEach(div => { html += generateStyledDivisionHTML(div); });
    } else if (_activeView === 'bunk') {
        selected.forEach(bunk => { html += generateStyledBunkHTML(bunk); });
    } else if (_activeView === 'location') {
        selected.forEach(loc => { html += generateStyledLocationHTML(loc); });
    }

    if (!html) {
        html = '<div style="text-align:center; padding:40px; color:#94A3B8;">No schedule data found for this date. Generate a schedule first.</div>';
    }

    previewContent.innerHTML = html;
    _previewHtml = html;
}

// =========================================================================
// PRINT & EXPORT
// =========================================================================

function triggerPrint() {
    const selected = getSelectedItems();
    if (selected.length === 0) return alert("Please select at least one item to print.");

    readDesignValues();
    
    let html = '';
    if (_activeView === 'division') {
        selected.forEach(div => { html += generateStyledDivisionHTML(div); });
    } else if (_activeView === 'bunk') {
        selected.forEach(bunk => { html += generateStyledBunkHTML(bunk); });
    } else if (_activeView === 'location') {
        selected.forEach(loc => { html += generateStyledLocationHTML(loc); });
    }

    const area = document.getElementById("printable-area");
    if (!area) return;
    area.innerHTML = html;

    // Inject print-specific style
    const printStyle = document.getElementById('pc-print-style') || document.createElement('style');
    printStyle.id = 'pc-print-style';
    printStyle.textContent = `
        @media print {
            @page {
                size: ${_currentTemplate.paperSize} ${_currentTemplate.orientation};
                margin: 0.5in;
            }
            body * { visibility: hidden; }
            #printable-area, #printable-area * { visibility: visible; }
            #printable-area {
                display: block !important;
                position: absolute;
                left: 0; top: 0; width: 100%;
            }
            .pc-print-page { page-break-inside: avoid; }
            .no-print { display: none !important; }
        }
    `;
    if (!document.getElementById('pc-print-style')) document.head.appendChild(printStyle);

    window.print();
}

function exportExcel() {
    const selected = getSelectedItems();
    if (selected.length === 0) return alert("Please select at least one item to export.");

    readDesignValues();

    let html = '';
    if (_activeView === 'division') {
        selected.forEach(div => { html += generateStyledDivisionHTML(div); });
    } else if (_activeView === 'bunk') {
        selected.forEach(bunk => { html += generateStyledBunkHTML(bunk); });
    } else if (_activeView === 'location') {
        selected.forEach(loc => { html += generateStyledLocationHTML(loc); });
    }

    const blob = new Blob([
        '<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="UTF-8"></head><body>' + html + '</body></html>'
    ], { type: 'application/vnd.ms-excel' });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Schedule_${_activeView}_${window.currentScheduleDate || 'export'}.xls`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// =========================================================================
// LOGO HANDLER
// =========================================================================

function handleLogoUpload(input) {
    if (!input.files || !input.files[0]) return;
    const file = input.files[0];
    if (file.size > 2 * 1024 * 1024) {
        alert("Logo file must be under 2MB.");
        return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
        _currentTemplate.campLogo = e.target.result;
        refreshPreview();
        // Update UI
        const removeBtn = document.getElementById('pc-remove-logo');
        if (removeBtn) removeBtn.style.display = 'inline-block';
        // Insert preview
        const existing = document.querySelector('.pc-logo-preview');
        if (existing) existing.src = e.target.result;
        else {
            const uploadDiv = document.querySelector('.pc-logo-upload');
            if (uploadDiv) {
                const img = document.createElement('img');
                img.src = e.target.result;
                img.className = 'pc-logo-preview';
                img.alt = 'Logo';
                uploadDiv.parentElement.appendChild(img);
            }
        }
    };
    reader.readAsDataURL(file);
}

function removeLogo() {
    _currentTemplate.campLogo = null;
    const existing = document.querySelector('.pc-logo-preview');
    if (existing) existing.remove();
    const removeBtn = document.getElementById('pc-remove-logo');
    if (removeBtn) removeBtn.style.display = 'none';
    const input = document.getElementById('pc-logo-input');
    if (input) input.value = '';
    refreshPreview();
}

// =========================================================================
// UTILITY
// =========================================================================

function debounce(fn, ms) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

// =========================================================================
// GLOBAL WINDOW BINDINGS
// =========================================================================

window._pcToggleDesignPanel = function() {
    const panel = document.getElementById('pc-design-panel');
    if (!panel) return;
    _designPanelOpen = !_designPanelOpen;
    panel.classList.toggle('open', _designPanelOpen);
    const text = document.getElementById('pc-design-toggle-text');
    if (text) text.textContent = _designPanelOpen ? 'Hide Design' : 'Design';
};

window._pcSelectAll = function() {
    document.querySelectorAll('.pc-item-cb').forEach(cb => cb.checked = true);
};

window._pcDeselectAll = function() {
    document.querySelectorAll('.pc-item-cb').forEach(cb => cb.checked = false);
};

window._pcRefreshPreview = function() {
    readDesignValues();
    refreshPreview();
};

window._pcPrint = triggerPrint;
window._pcExportExcel = exportExcel;
window._pcHandleLogo = handleLogoUpload;
window._pcRemoveLogo = removeLogo;

window._pcLoadTemplate = function(templateId) {
    loadTemplate(templateId);
    localStorage.setItem('campistry_last_print_template', templateId);
};

window._pcSaveAsTemplate = function() {
    if (!canEditTemplates()) {
        alert('Only owners and admins can save templates.');
        return;
    }
    const name = prompt('Template name:', 'My Custom Template');
    if (!name) return;
    readDesignValues();
    const tpl = saveCurrentAsTemplate(name);
    if (tpl) {
        _currentTemplate.id = tpl.id;
        renderTemplateDropdown();
        localStorage.setItem('campistry_last_print_template', tpl.id);
        if (typeof window.showToast === 'function') window.showToast('Template saved!', 'success');
    }
};

window._pcUpdateTemplate = function() {
    if (!canEditTemplates()) return;
    const currentId = _currentTemplate.id;
    if (!currentId || currentId === 'default') return;
    readDesignValues();
    if (updateTemplate(currentId)) {
        if (typeof window.showToast === 'function') window.showToast('Template updated!', 'success');
    }
};

window._pcDeleteTemplate = function() {
    if (!canEditTemplates()) return;
    const currentId = _currentTemplate.id;
    if (!currentId || currentId === 'default') return;
    if (!confirm('Delete this template?')) return;
    deleteTemplate(currentId);
    _currentTemplate = { ...DEFAULT_TEMPLATE };
    renderTemplateDropdown();
    localStorage.setItem('campistry_last_print_template', 'default');
    refreshPreview();
    if (typeof window.showToast === 'function') window.showToast('Template deleted.', 'info');
};

window._pcResetToDefault = function() {
    _currentTemplate = { ...DEFAULT_TEMPLATE };
    // Re-render the entire print center to refresh all inputs
    initPrintCenter();
};

// Legacy compatibility
window.printAllDivisions = function() {
    document.querySelectorAll('.pc-view-tab').forEach(b => b.classList.remove('active'));
    document.querySelector('.pc-view-tab[data-view="division"]')?.classList.add('active');
    _activeView = 'division';
    populateSelectors();
    window._pcSelectAll();
    readDesignValues();
    triggerPrint();
};

window.exportAllDivisionsToExcel = function() {
    _activeView = 'division';
    populateSelectors();
    window._pcSelectAll();
    readDesignValues();
    exportExcel();
};

window.initPrintCenter = initPrintCenter;

})();
