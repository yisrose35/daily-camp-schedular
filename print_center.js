// =================================================================
// print_center.js
//
// Handles generating printable schedules.
// Features:
// - Print Whole Schedule (All Divisions) - Layout matches Daily View
// - Print Selected Divisions (Multi-select)
// - Print Selected Bunks (Multi-select) - Natural Sort & Excel
// - Print Selected Locations (Multi-select) - Excel Export
// - UPDATED: Bunk view shows FULL league schedule (all matchups).
// - UPDATED: Field view shows ONLY the specific matchup on that field.
// - UPDATED: Support for Division-Specific Timelines (DivisionTimes)
// - NEW v2.0: Print Preview Modal with full customization options
// =================================================================

(function() {
'use strict';

// =========================================================================
// PRINT SETTINGS - Cloud-persisted customization
// =========================================================================

const DEFAULT_PRINT_SETTINGS = {
    headerText: '',              // Custom header (defaults to camp name if empty)
    showCampName: true,          // Show camp name in header
    showDate: true,              // Show date in header
    showEmojis: true,            // Show emojis in headers (📅, 👤, 📍)
    fontSize: 'medium',          // 'small', 'medium', 'large'
    layoutOrientation: 'times-left', // 'bunks-left' (bunks=rows) or 'times-left' (times=rows, bunks=cols) - DEFAULT
    showSportNames: true,        // Show sport names in cells
    showEmptySlots: true,        // Show empty/free slots
    showLeagueDetails: true,     // Show league matchup details
    grayscale: false,            // Grayscale-friendly mode
    showFieldInCell: true,       // Show field name in activity cells
    compactMode: false           // Reduce padding for more data per page
};

let _printSettings = { ...DEFAULT_PRINT_SETTINGS };
let _currentPrintType = null;    // 'divisions', 'bunks', 'locations'
let _currentPrintItems = [];     // Items selected to print

function loadPrintSettings() {
    try {
        const global = window.loadGlobalSettings?.() || {};
        const saved = global.printSettings || global.app1?.printSettings;
        if (saved && typeof saved === 'object') {
            _printSettings = { ...DEFAULT_PRINT_SETTINGS, ...saved };
        }
    } catch (e) {
        console.warn('[PrintCenter] Failed to load print settings:', e);
    }
    return _printSettings;
}

function savePrintSettings() {
    try {
        window.saveGlobalSettings?.('printSettings', _printSettings);
        console.log('[PrintCenter] ✅ Print settings saved');
    } catch (e) {
        console.warn('[PrintCenter] Failed to save print settings:', e);
    }
}

function getPrintSettings() {
    return _printSettings;
}

function updatePrintSetting(key, value) {
    _printSettings[key] = value;
    savePrintSettings();
    refreshPrintPreview();
}

// Helper: Get header text for printouts
function getPrintHeader() {
    const settings = getPrintSettings();
    if (settings.headerText && settings.headerText.trim()) {
        return settings.headerText.trim();
    }
    if (settings.showCampName) {
        const global = window.loadGlobalSettings?.() || {};
        return global.campName || global.app1?.campName || localStorage.getItem('campName') || '';
    }
    return '';
}

// Helper: Get emoji based on type
function getTypeEmoji(type) {
    if (!getPrintSettings().showEmojis) return '';
    const emojis = {
        'division': '📅 ',
        'bunk': '👤 ',
        'location': '📍 '
    };
    return emojis[type] || '';
}

// Helper: Get font size class
function getFontSizeClass() {
    const size = getPrintSettings().fontSize || 'medium';
    return `print-font-${size}`;
}

// Helper: Get CSS classes for print
function getPrintClasses() {
    const settings = getPrintSettings();
    let classes = [getFontSizeClass()];
    if (settings.grayscale) classes.push('print-grayscale');
    if (settings.compactMode) classes.push('print-compact');
    return classes.join(' ');
}

// --- Helpers Copied/Adapted from scheduler_ui.js for consistency ---
const INCREMENT_MINS = 30;

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
          if (slotStart >= startMin && slotStart < startMin + INCREMENT_MINS) {
            return i;
          }
      }
      return -1;
  }

  const times = window.unifiedTimes || [];
  if (startMin === null || !times.length) return -1;
  for (let i = 0; i < times.length; i++) {
    const slot = times[i];
    const slotStart = new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes();
    if (slotStart >= startMin && slotStart < startMin + INCREMENT_MINS) {
      return i;
    }
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
  
  const settings = getPrintSettings();
  let label = "";
  
  if (settings.showFieldInCell) {
    if (typeof entry.field === 'string') label = entry.field;
    else if (entry.field && entry.field.name) label = entry.field.name;
  }

  if (entry._h2h) {
    if (settings.showSportNames) {
      return entry.sport || "League Game";
    }
    return "League Game";
  }
  if (entry._fixed) return label || entry._activity || "";
  if (entry.sport && settings.showSportNames) {
    return label ? `${label} – ${entry.sport}` : entry.sport;
  }
  return label;
}

function naturalSort(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

// =========================================================================
// PRINT PREVIEW MODAL
// =========================================================================

function openPrintPreviewModal(type, items) {
    _currentPrintType = type;
    _currentPrintItems = items;
    
    // Remove existing modal if any
    const existingModal = document.getElementById('print-preview-modal');
    if (existingModal) existingModal.remove();
    
    const settings = getPrintSettings();
    
    const modal = document.createElement('div');
    modal.id = 'print-preview-modal';
    modal.className = 'print-preview-modal-overlay';
    modal.innerHTML = `
        <div class="print-preview-modal">
            <div class="print-preview-header">
                <h2>🖨️ Print Preview</h2>
                <button class="print-preview-close" onclick="window.closePrintPreviewModal()">✕</button>
            </div>
            
            <div class="print-preview-body">
                <!-- Left: Settings Panel -->
                <div class="print-preview-settings">
                    <h3>Customize Layout</h3>
                    
                    <!-- Header Section -->
                    <div class="print-settings-section">
                        <div class="print-settings-section-title">Header</div>
                        
                        <label class="print-setting-row">
                            <span>Custom Header Text</span>
                            <input type="text" id="ps-header-text" value="${settings.headerText || ''}" 
                                   placeholder="Leave blank for camp name"
                                   onchange="window.updatePrintSettingUI('headerText', this.value)">
                        </label>
                        
                        <label class="print-setting-row checkbox">
                            <input type="checkbox" id="ps-show-camp-name" ${settings.showCampName ? 'checked' : ''}
                                   onchange="window.updatePrintSettingUI('showCampName', this.checked)">
                            <span>Show camp name (if no custom header)</span>
                        </label>
                        
                        <label class="print-setting-row checkbox">
                            <input type="checkbox" id="ps-show-date" ${settings.showDate ? 'checked' : ''}
                                   onchange="window.updatePrintSettingUI('showDate', this.checked)">
                            <span>Show date</span>
                        </label>
                        
                        <label class="print-setting-row checkbox">
                            <input type="checkbox" id="ps-show-emojis" ${settings.showEmojis ? 'checked' : ''}
                                   onchange="window.updatePrintSettingUI('showEmojis', this.checked)">
                            <span>Show emojis (📅 👤 📍)</span>
                        </label>
                    </div>
                    
                    <!-- Layout Section -->
                    <div class="print-settings-section">
                        <div class="print-settings-section-title">Layout</div>
                        
                        <div class="print-setting-row">
                            <span>Table Orientation</span>
                            <select id="ps-layout" onchange="window.updatePrintSettingUI('layoutOrientation', this.value)">
                                <option value="times-left" ${settings.layoutOrientation === 'times-left' ? 'selected' : ''}>
                                    Times on Left, Bunks on Top
                                </option>
                                <option value="bunks-left" ${settings.layoutOrientation === 'bunks-left' ? 'selected' : ''}>
                                    Bunks on Left, Times on Top
                                </option>
                            </select>
                        </div>
                        
                        <div class="print-setting-row">
                            <span>Font Size</span>
                            <select id="ps-font-size" onchange="window.updatePrintSettingUI('fontSize', this.value)">
                                <option value="small" ${settings.fontSize === 'small' ? 'selected' : ''}>Small</option>
                                <option value="medium" ${settings.fontSize === 'medium' ? 'selected' : ''}>Medium</option>
                                <option value="large" ${settings.fontSize === 'large' ? 'selected' : ''}>Large</option>
                            </select>
                        </div>
                        
                        <label class="print-setting-row checkbox">
                            <input type="checkbox" id="ps-compact" ${settings.compactMode ? 'checked' : ''}
                                   onchange="window.updatePrintSettingUI('compactMode', this.checked)">
                            <span>Compact mode (less padding)</span>
                        </label>
                        
                        <label class="print-setting-row checkbox">
                            <input type="checkbox" id="ps-grayscale" ${settings.grayscale ? 'checked' : ''}
                                   onchange="window.updatePrintSettingUI('grayscale', this.checked)">
                            <span>Grayscale (B&W friendly)</span>
                        </label>
                    </div>
                    
                    <!-- Content Section -->
                    <div class="print-settings-section">
                        <div class="print-settings-section-title">Content</div>
                        
                        <label class="print-setting-row checkbox">
                            <input type="checkbox" id="ps-show-sports" ${settings.showSportNames ? 'checked' : ''}
                                   onchange="window.updatePrintSettingUI('showSportNames', this.checked)">
                            <span>Show sport names</span>
                        </label>
                        
                        <label class="print-setting-row checkbox">
                            <input type="checkbox" id="ps-show-fields" ${settings.showFieldInCell ? 'checked' : ''}
                                   onchange="window.updatePrintSettingUI('showFieldInCell', this.checked)">
                            <span>Show field/location in cells</span>
                        </label>
                        
                        <label class="print-setting-row checkbox">
                            <input type="checkbox" id="ps-show-empty" ${settings.showEmptySlots ? 'checked' : ''}
                                   onchange="window.updatePrintSettingUI('showEmptySlots', this.checked)">
                            <span>Show empty slots</span>
                        </label>
                        
                        <label class="print-setting-row checkbox">
                            <input type="checkbox" id="ps-show-league" ${settings.showLeagueDetails ? 'checked' : ''}
                                   onchange="window.updatePrintSettingUI('showLeagueDetails', this.checked)">
                            <span>Show league matchup details</span>
                        </label>
                    </div>
                </div>
                
                <!-- Right: Preview Area -->
                <div class="print-preview-area">
                    <div class="print-preview-label">Preview (scroll to see all)</div>
                    <div class="print-preview-content" id="print-preview-content">
                        <!-- Generated preview will go here -->
                    </div>
                </div>
            </div>
            
            <div class="print-preview-footer">
                <button class="print-preview-btn secondary" onclick="window.closePrintPreviewModal()">Cancel</button>
                <button class="print-preview-btn secondary" onclick="window.exportCurrentToExcel()">📊 Export to Excel</button>
                <button class="print-preview-btn primary" onclick="window.printFromPreview()">🖨️ Print</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Generate initial preview
    refreshPrintPreview();
    
    // Close on escape
    document.addEventListener('keydown', handleEscapeKey);
}

function handleEscapeKey(e) {
    if (e.key === 'Escape') {
        window.closePrintPreviewModal();
    }
}

window.closePrintPreviewModal = function() {
    const modal = document.getElementById('print-preview-modal');
    if (modal) modal.remove();
    document.removeEventListener('keydown', handleEscapeKey);
    _currentPrintType = null;
    _currentPrintItems = [];
};

window.updatePrintSettingUI = function(key, value) {
    updatePrintSetting(key, value);
};

function refreshPrintPreview() {
    const previewContainer = document.getElementById('print-preview-content');
    if (!previewContainer || !_currentPrintType || !_currentPrintItems.length) return;
    
    let html = '';
    
    if (_currentPrintType === 'divisions') {
        _currentPrintItems.forEach(div => {
            html += generateDivisionHTML(div);
        });
    } else if (_currentPrintType === 'bunks') {
        _currentPrintItems.forEach(bunk => {
            html += generateBunkHTML(bunk);
        });
    } else if (_currentPrintType === 'locations') {
        _currentPrintItems.forEach(loc => {
            html += generateLocationHTML(loc);
        });
    }
    
    previewContainer.innerHTML = html;
}

window.printFromPreview = function() {
    const previewContent = document.getElementById('print-preview-content');
    if (!previewContent) return;
    
    const printArea = document.getElementById('printable-area');
    if (printArea) {
        printArea.innerHTML = previewContent.innerHTML;
    }
    
    window.closePrintPreviewModal();
    
    setTimeout(() => {
        window.print();
    }, 100);
};

window.exportCurrentToExcel = function() {
    if (!_currentPrintType || !_currentPrintItems.length) return;
    
    let fullHtml = '';
    
    if (_currentPrintType === 'divisions') {
        _currentPrintItems.forEach(div => {
            fullHtml += generateDivisionHTML(div);
        });
        downloadXLS(fullHtml, `Schedule_Divisions_${window.currentScheduleDate}.xls`);
    } else if (_currentPrintType === 'bunks') {
        _currentPrintItems.forEach(bunk => {
            fullHtml += generateBunkHTML(bunk);
        });
        downloadXLS(fullHtml, `Schedule_Bunks_${window.currentScheduleDate}.xls`);
    } else if (_currentPrintType === 'locations') {
        _currentPrintItems.forEach(loc => {
            fullHtml += generateLocationHTML(loc);
        });
        downloadXLS(fullHtml, `Schedule_Locations_${window.currentScheduleDate}.xls`);
    }
};

// =========================================================================
// INIT PRINT CENTER
// =========================================================================

function initPrintCenter() {
    const container = document.getElementById("print-content");
    if (!container) return;
    
    // Load saved settings
    loadPrintSettings();

    container.innerHTML = `
        <div class="print-dashboard">
            <h1 style="color:#1a5fb4;">🖨️ Print Center</h1>
            <p class="no-print">Select what you want to print, then customize the layout in the preview.</p>

            <div class="print-cards no-print">
                
                <div class="print-card">
                    <h3>📅 Master Schedule</h3>
                    <p>Print grid views for divisions.</p>
                    
                    <div style="display:flex; gap:10px; margin-bottom:15px;">
                        <button onclick="window.printAllDivisions()" style="background:#28a745; flex:1;">Print All Divisions</button>
                    </div>

                    <hr style="border-top:1px solid #ddd; margin:10px 0;">
                    
                    <label style="font-weight:bold; display:block; margin-bottom:5px;">Or Select Specific Divisions:</label>
                    <div id="print-div-list" class="print-list-box"></div>
                    <button onclick="window.printSelectedDivisions()" style="width:100%;">Print Selected Divisions</button>
                </div>

                <div class="print-card">
                    <h3>👤 Individual Bunks</h3>
                    <p>Print list views for specific bunks.</p>
                    <div id="print-bunk-list" class="print-list-box"></div>
                    <button onclick="window.printSelectedBunks()" style="width:100%;">Print Selected Bunks</button>
                </div>

                <div class="print-card">
                    <h3>📍 Locations / Fields</h3>
                    <p>Print schedules for specific fields.</p>
                    <div id="print-loc-list" class="print-list-box"></div>
                    <button onclick="window.printSelectedLocations()" style="width:100%;">Print Selected Locations</button>
                </div>
            </div>

            <div id="printable-area"></div>
        </div>
        
        <style>
            .print-list-box {
                max-height: 200px;
                overflow-y: auto;
                border: 1px solid #ccc;
                padding: 10px;
                background: white;
                margin-bottom: 10px;
                border-radius: 4px;
            }
            .print-list-group {
                font-weight: bold;
                margin-top: 5px;
                margin-bottom: 3px;
                color: #555;
                background: #eee;
                padding: 2px 5px;
            }
            .print-list-item {
                display: block;
                margin-left: 5px;
                margin-bottom: 2px;
            }
            
            /* ========================================= */
            /* PRINT PREVIEW MODAL STYLES               */
            /* ========================================= */
            .print-preview-modal-overlay {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0,0,0,0.6);
                z-index: 10000;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 20px;
            }
            
            .print-preview-modal {
                background: #fff;
                border-radius: 16px;
                width: 100%;
                max-width: 1200px;
                max-height: 90vh;
                display: flex;
                flex-direction: column;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                overflow: hidden;
            }
            
            .print-preview-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 16px 24px;
                border-bottom: 1px solid #e2e8f0;
                background: #f8fafc;
            }
            
            .print-preview-header h2 {
                margin: 0;
                font-size: 1.25rem;
                color: #1e293b;
            }
            
            .print-preview-close {
                background: none;
                border: none;
                font-size: 1.5rem;
                cursor: pointer;
                color: #64748b;
                padding: 4px 8px;
                border-radius: 8px;
                transition: all 0.2s;
            }
            
            .print-preview-close:hover {
                background: #fee2e2;
                color: #dc2626;
            }
            
            .print-preview-body {
                display: flex;
                flex: 1;
                min-height: 0;
                overflow: hidden;
            }
            
            .print-preview-settings {
                width: 300px;
                flex-shrink: 0;
                padding: 20px;
                border-right: 1px solid #e2e8f0;
                overflow-y: auto;
                background: #fafafa;
            }
            
            .print-preview-settings h3 {
                margin: 0 0 16px 0;
                font-size: 1rem;
                color: #334155;
            }
            
            .print-settings-section {
                margin-bottom: 20px;
                padding-bottom: 16px;
                border-bottom: 1px solid #e2e8f0;
            }
            
            .print-settings-section:last-child {
                border-bottom: none;
            }
            
            .print-settings-section-title {
                font-weight: 600;
                font-size: 0.85rem;
                color: #147D91;
                margin-bottom: 12px;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }
            
            .print-setting-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 10px;
                font-size: 0.9rem;
                color: #475569;
            }
            
            .print-setting-row.checkbox {
                justify-content: flex-start;
                gap: 10px;
            }
            
            .print-setting-row input[type="text"] {
                width: 140px;
                padding: 6px 10px;
                border: 1px solid #cbd5e1;
                border-radius: 6px;
                font-size: 0.85rem;
            }
            
            .print-setting-row input[type="text"]:focus {
                outline: none;
                border-color: #147D91;
                box-shadow: 0 0 0 2px rgba(20,125,145,0.1);
            }
            
            .print-setting-row select {
                padding: 6px 10px;
                border: 1px solid #cbd5e1;
                border-radius: 6px;
                font-size: 0.85rem;
                background: white;
            }
            
            .print-setting-row input[type="checkbox"] {
                width: 16px;
                height: 16px;
                accent-color: #147D91;
            }
            
            .print-preview-area {
                flex: 1;
                display: flex;
                flex-direction: column;
                min-width: 0;
                padding: 16px;
                background: #f1f5f9;
            }
            
            .print-preview-label {
                font-size: 0.8rem;
                color: #64748b;
                margin-bottom: 8px;
                font-weight: 500;
            }
            
            .print-preview-content {
                flex: 1;
                overflow: auto;
                background: white;
                border: 1px solid #e2e8f0;
                border-radius: 8px;
                padding: 20px;
                box-shadow: inset 0 2px 4px rgba(0,0,0,0.05);
            }
            
            .print-preview-footer {
                display: flex;
                justify-content: flex-end;
                gap: 12px;
                padding: 16px 24px;
                border-top: 1px solid #e2e8f0;
                background: #f8fafc;
            }
            
            .print-preview-btn {
                padding: 10px 20px;
                border-radius: 8px;
                font-weight: 600;
                font-size: 0.9rem;
                cursor: pointer;
                transition: all 0.2s;
                border: none;
            }
            
            .print-preview-btn.primary {
                background: #147D91;
                color: white;
            }
            
            .print-preview-btn.primary:hover {
                background: #0f5f6e;
            }
            
            .print-preview-btn.secondary {
                background: #e2e8f0;
                color: #475569;
            }
            
            .print-preview-btn.secondary:hover {
                background: #cbd5e1;
            }
            
            /* ========================================= */
            /* PRINT DOCUMENT STYLES (in preview)       */
            /* ========================================= */
            .print-page {
                margin-bottom: 30px;
                page-break-after: always;
            }
            
            .print-page:last-child {
                page-break-after: avoid;
            }
            
            .print-header {
                margin-bottom: 16px;
                text-align: center;
            }
            
            .print-camp-name {
                font-size: 1.4em;
                font-weight: 700;
                color: #1a5fb4;
                margin-bottom: 4px;
            }
            
            .print-header h2 {
                margin: 0 0 4px 0;
                font-size: 1.2em;
                color: #1e293b;
            }
            
            .print-header p {
                margin: 0;
                font-size: 0.9em;
                color: #64748b;
            }
            
            .print-table {
                width: 100%;
                border-collapse: collapse;
                font-size: 11pt;
            }
            
            .print-table th,
            .print-table td {
                border: 1px solid #333;
                padding: 8px;
                text-align: left;
                vertical-align: top;
            }
            
            .print-table th {
                background: #e8e8e8;
                font-weight: 600;
            }
            
            .print-table .time-col {
                background: #f5f5f5;
                white-space: nowrap;
            }
            
            /* Font size variations */
            .print-font-small .print-table { font-size: 9pt; }
            .print-font-small .print-table th,
            .print-font-small .print-table td { padding: 4px 6px; }
            
            .print-font-medium .print-table { font-size: 11pt; }
            .print-font-medium .print-table th,
            .print-font-medium .print-table td { padding: 8px; }
            
            .print-font-large .print-table { font-size: 13pt; }
            .print-font-large .print-table th,
            .print-font-large .print-table td { padding: 10px 12px; }
            
            /* Compact mode */
            .print-compact .print-table th,
            .print-compact .print-table td { padding: 3px 5px; }
            .print-compact .print-header { margin-bottom: 8px; }
            
            /* Grayscale mode */
            .print-grayscale .print-table th { background: #ddd; }
            .print-grayscale .print-camp-name { color: #000; }
            .print-grayscale td[style*="background"] { background: #f5f5f5 !important; }
            
        </style>
    `;

    populateSelectors();
}

function populateSelectors() {
    const divList = document.getElementById("print-div-list");
    const bunkList = document.getElementById("print-bunk-list");
    const locList = document.getElementById("print-loc-list");
    
    const app1 = window.loadGlobalSettings?.().app1 || {};
    const divisions = app1.divisions || {};
    const availableDivisions = app1.availableDivisions || [];
    const fields = app1.fields || [];
    const specials = app1.specialActivities || [];
    
    // 1. Divisions Checkboxes
    divList.innerHTML = "";
    availableDivisions.forEach(divName => {
        divList.innerHTML += `<label class="print-list-item"><input type="checkbox" value="${divName}"> ${divName}</label>`;
    });

    // 2. Bunks Checkboxes (Grouped by Division)
    bunkList.innerHTML = "";
    availableDivisions.forEach(divName => {
        const bunks = (divisions[divName]?.bunks || []).sort(naturalSort);
        if (bunks.length > 0) {
            bunkList.innerHTML += `<div class="print-list-group">${divName}</div>`;
            bunks.forEach(b => {
                bunkList.innerHTML += `<label class="print-list-item"><input type="checkbox" value="${b}"> ${b}</label>`;
            });
        }
    });

    // 3. Locations Checkboxes
    locList.innerHTML = "";
    const allLocs = [...fields.map(f=>f.name), ...specials.map(s=>s.name)].sort(naturalSort);
    allLocs.forEach(loc => {
        locList.innerHTML += `<label class="print-list-item"><input type="checkbox" value="${loc}"> ${loc}</label>`;
    });
}

// =========================================================================
// HTML GENERATORS
// =========================================================================

/**
 * Generates the HTML for a Division using the "Daily View" logic (Timeline Blocks).
 * Supports both layout orientations.
 */
function generateDivisionHTML(divName) {
    const daily = window.loadCurrentDailyData?.() || {};
    const manualSkeleton = daily.manualSkeleton || [];
    const divisions = window.loadGlobalSettings?.().app1.divisions || {};
    const bunks = (divisions[divName]?.bunks || []).sort(naturalSort);
    const settings = getPrintSettings();

    if (bunks.length === 0) return "";

    // --- 1. Build Blocks Logic ---
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
    let leagueCounter = 0; 
    let specialtyCounter = 0;

    tempSortedBlocks.forEach(block => {
        let eventName = block.item.event;
        if (block.item.event === "League Game") {
            leagueCounter++;
            eventName = `League Game ${leagueCounter}`;
        } else if (block.item.event === "Specialty League") {
            specialtyCounter++;
            eventName = `Specialty League ${specialtyCounter}`;
        }

        divisionBlocks.push({
            label: `${minutesToTimeLabel(block.startMin)} - ${minutesToTimeLabel(block.endMin)}`,
            startMin: block.startMin,
            endMin: block.endMin,
            event: eventName,
            type: block.item.type
        });
    });

    const uniqueBlocks = divisionBlocks.filter((block, index, self) => 
        index === self.findIndex((t) => t.label === block.label)
    );

    const flattenedBlocks = [];
    uniqueBlocks.forEach((block) => {
        if (block.type === "split" && block.startMin !== null && block.endMin !== null) {
            const midMin = Math.round(block.startMin + (block.endMin - block.startMin) / 2);
            flattenedBlocks.push({
                ...block,
                label: `${minutesToTimeLabel(block.startMin)} - ${minutesToTimeLabel(midMin)}`,
                startMin: block.startMin,
                endMin: midMin,
                splitPart: 1
            });
            flattenedBlocks.push({
                ...block,
                label: `${minutesToTimeLabel(midMin)} - ${minutesToTimeLabel(block.endMin)}`,
                startMin: midMin,
                endMin: block.endMin,
                splitPart: 2
            });
        } else {
            flattenedBlocks.push(block);
        }
    });

    // --- 2. Build Header ---
    const headerText = getPrintHeader();
    const emoji = getTypeEmoji('division');
    const printClasses = getPrintClasses();
    
    let html = `
        <div class="print-page landscape ${printClasses}">
            <div class="print-header">
                ${headerText ? `<div class="print-camp-name">${headerText}</div>` : ''}
                <h2>${emoji}${divName} Schedule</h2>
                ${settings.showDate ? `<p>Date: ${window.currentScheduleDate}</p>` : ''}
            </div>
    `;

    // --- 3. Build Table Based on Orientation ---
    if (settings.layoutOrientation === 'bunks-left') {
        // Bunks as ROWS, Times as COLUMNS
        html += `
            <table class="print-table grid-table">
                <thead>
                    <tr>
                        <th style="width:100px;">Bunk</th>
                        ${flattenedBlocks.map(b => `<th style="font-size:0.85em;">${b.label}</th>`).join('')}
                    </tr>
                </thead>
                <tbody>
        `;

        if (flattenedBlocks.length === 0) {
            html += `<tr><td colspan="${bunks.length + 1}" style="text-align:center; padding:20px;">No schedule blocks found.</td></tr>`;
        } else {
            bunks.forEach(bunk => {
                html += `<tr><td class="time-col"><strong>${bunk}</strong></td>`;
                
                flattenedBlocks.forEach(eventBlock => {
                    const isLeague = eventBlock.event.startsWith("League Game") || eventBlock.event.startsWith("Specialty League");
                    const slotIndex = findFirstSlotForTime(eventBlock.startMin, divName);
                    const entry = getEntry(bunk, slotIndex);
                    let text = "";
                    let bg = "";

                    if (isLeague && entry && entry._h2h) {
                        text = settings.showLeagueDetails && entry.sport ? entry.sport : "League";
                        bg = settings.grayscale ? "#f0f0f0" : "#e8f4ff";
                    } else if (entry) {
                        text = formatEntry(entry);
                        if (entry._fixed) bg = settings.grayscale ? "#f0f0f0" : "#fff8e1";
                    } else {
                        if (["Lunch","Snack","Dismissal","Swim"].some(k => eventBlock.event.includes(k))) {
                            text = eventBlock.event;
                            bg = settings.grayscale ? "#f0f0f0" : "#fff8e1";
                        } else if (settings.showEmptySlots) {
                            text = "";
                        }
                    }
                    
                    html += `<td style="background:${bg};">${text}</td>`;
                });
                
                html += `</tr>`;
            });
        }
        
        html += `</tbody></table>`;
        
    } else {
        // Times as ROWS, Bunks as COLUMNS (default - times-left)
        html += `
            <table class="print-table grid-table">
                <thead>
                    <tr>
                        <th style="width:130px;">Time</th>
                        ${bunks.map(b => `<th>${b}</th>`).join('')}
                    </tr>
                </thead>
                <tbody>
        `;

        if (flattenedBlocks.length === 0) {
            html += `<tr><td colspan="${bunks.length + 1}" style="text-align:center; padding:20px;">No schedule blocks found.</td></tr>`;
        }

        flattenedBlocks.forEach(eventBlock => {
            html += `<tr>`;
            html += `<td class="time-col"><strong>${eventBlock.label}</strong></td>`;

            const isLeague = eventBlock.event.startsWith("League Game") || eventBlock.event.startsWith("Specialty League");
            
            if (isLeague) {
                const firstSlotIndex = findFirstSlotForTime(eventBlock.startMin, divName);
                let allMatchups = [];
                if (bunks.length > 0) {
                    const entry = getEntry(bunks[0], firstSlotIndex);
                    if (entry && entry._allMatchups) allMatchups = entry._allMatchups;
                }

                let cellContent = `<strong>${eventBlock.event}</strong>`;
                if (settings.showLeagueDetails && allMatchups.length > 0) {
                    cellContent += `<ul style="margin:0; padding-left:15px; text-align:left; font-size:0.9em;">`;
                    allMatchups.forEach(m => cellContent += `<li>${m}</li>`);
                    cellContent += `</ul>`;
                } else if (allMatchups.length === 0) {
                    cellContent += `<br><em>(No matchups)</em>`;
                }

                const leagueBg = settings.grayscale ? "#f0f0f0" : "#e8f4ff";
                html += `<td colspan="${bunks.length}" style="background:${leagueBg}; vertical-align:top; text-align:left;">${cellContent}</td>`;

            } else {
                bunks.forEach(bunk => {
                    const slotIndex = findFirstSlotForTime(eventBlock.startMin, divName);
                    const entry = getEntry(bunk, slotIndex);
                    let text = "";
                    let bg = "";

                    if (entry) {
                        text = formatEntry(entry);
                        if (entry._fixed) bg = settings.grayscale ? "#f0f0f0" : "#fff8e1";
                    } else {
                        if (["Lunch","Snack","Dismissal","Swim"].some(k => eventBlock.event.includes(k))) {
                            text = eventBlock.event;
                            bg = settings.grayscale ? "#f0f0f0" : "#fff8e1";
                        } else if (settings.showEmptySlots) {
                            text = "";
                        }
                    }
                    
                    html += `<td style="background:${bg};">${text}</td>`;
                });
            }
            html += `</tr>`;
        });

        html += `</tbody></table>`;
    }

    html += `</div><div class="page-break"></div>`;
    return html;
}

// --- 2. Individual Bunk HTML ---
function generateBunkHTML(bunk) {
    const daily = window.loadCurrentDailyData?.() || {};
    const schedule = daily.scheduleAssignments?.[bunk] || [];
    const settings = getPrintSettings();
    
    let divName = null;
    const divisions = window.loadGlobalSettings?.().app1.divisions || {};
    for (const [dName, dData] of Object.entries(divisions)) {
        if (dData.bunks && dData.bunks.includes(bunk)) {
            divName = dName;
            break;
        }
    }
    
    const times = (divName && window.divisionTimes?.[divName]) || window.unifiedTimes || [];
    const headerText = getPrintHeader();
    const emoji = getTypeEmoji('bunk');
    const printClasses = getPrintClasses();

    let html = `
        <div class="print-page portrait ${printClasses}">
            <div class="print-header">
                ${headerText ? `<div class="print-camp-name">${headerText}</div>` : ''}
                <h2>${emoji}Schedule: ${bunk}</h2>
                ${settings.showDate ? `<p>Date: ${window.currentScheduleDate}</p>` : ''}
            </div>
            <table class="print-table">
                <thead><tr><th style="width:120px;">Time</th><th>Activity / Location</th></tr></thead>
                <tbody>
    `;

    times.forEach((t, i) => {
        const entry = schedule[i];
        if (!entry || entry.continuation) return; 

        let label = "";
        if (typeof entry.field === 'object') label = entry.field.name;
        else label = entry.field;
        
        // Show empty slots check
        if (!entry.field && !entry._h2h && !entry._fixed) {
            if (!settings.showEmptySlots) return;
        }
        
        if (entry._h2h) {
            if (settings.showLeagueDetails && entry._allMatchups && entry._allMatchups.length > 0) {
                label = `<strong>${entry.sport || "League Game"}</strong><br>`;
                label += `<ul style="margin:5px 0 0 15px; padding:0; font-size:0.9em; color:#555;">`;
                entry._allMatchups.forEach(m => {
                    if (entry.sport && m === entry.sport) {
                         label += `<li><strong>${m}</strong></li>`;
                    } else {
                         label += `<li>${m}</li>`;
                    }
                });
                label += `</ul>`;
            } else {
                label = `<strong>${entry.sport || "League Game"}</strong>`;
            }
        }

        html += `<tr>
            <td class="time-col"><strong>${t.label}</strong></td>
            <td>${label}</td>
        </tr>`;
    });

    html += `</tbody></table></div>`;
    return html;
}

// --- 3. Location HTML ---
function generateLocationHTML(loc) {
    const daily = window.loadCurrentDailyData?.() || {};
    const times = window.unifiedTimes || [];
    const assignments = daily.scheduleAssignments || {};
    const settings = getPrintSettings();
    const headerText = getPrintHeader();
    const emoji = getTypeEmoji('location');
    const printClasses = getPrintClasses();

    let html = `
        <div class="print-page portrait ${printClasses}">
            <div class="print-header">
                ${headerText ? `<div class="print-camp-name">${headerText}</div>` : ''}
                <h2>${emoji}Schedule: ${loc}</h2>
                ${settings.showDate ? `<p>Date: ${window.currentScheduleDate}</p>` : ''}
            </div>
            <table class="print-table">
                <thead><tr><th style="width:120px;">Time</th><th>Event / Bunks</th></tr></thead>
                <tbody>
    `;

    times.forEach((t, i) => {
        const bunksHere = [];
        let leagueLabel = null;

        Object.keys(assignments).forEach(b => {
            const entry = assignments[b][i];
            if (entry) {
                const fName = (typeof entry.field === 'object') ? entry.field.name : entry.field;
                if (fName === loc) {
                    if(!bunksHere.includes(b)) bunksHere.push(b);
                    
                    if (entry._h2h && entry.sport) {
                        let matchStr = entry.sport; 
                        if(matchStr.includes('@')) matchStr = matchStr.split('@')[0].trim();
                        leagueLabel = matchStr;
                    }
                }
            }
        });

        let content = "";
        let style = "";

        if (leagueLabel) {
            content = `<strong>${leagueLabel}</strong>`;
        } else if (bunksHere.length > 0) {
            content = bunksHere.join(", ");
        } else {
            if (!settings.showEmptySlots) return;
            content = "-- Free --";
            style = "color:#999; font-style:italic;";
        }

        html += `<tr>
            <td class="time-col"><strong>${t.label}</strong></td>
            <td style="${style}">${content}</td>
        </tr>`;
    });

    html += `</tbody></table></div>`;
    return html;
}

// =========================================================================
// ACTIONS - Now open preview modal instead of direct print
// =========================================================================

function getSelectedDivisions() {
    const checkboxes = document.querySelectorAll("#print-div-list input:checked");
    return Array.from(checkboxes).map(cb => cb.value);
}

function getSelectedBunks() {
    const checkboxes = document.querySelectorAll("#print-bunk-list input:checked");
    return Array.from(checkboxes).map(cb => cb.value);
}

function getSelectedLocations() {
    const checkboxes = document.querySelectorAll("#print-loc-list input:checked");
    return Array.from(checkboxes).map(cb => cb.value);
}

window.printAllDivisions = function() {
    const app1 = window.loadGlobalSettings?.().app1 || {};
    const allDivs = app1.availableDivisions || [];
    if (allDivs.length === 0) return alert("No divisions found.");
    
    openPrintPreviewModal('divisions', allDivs);
};

window.printSelectedDivisions = function() {
    const selected = getSelectedDivisions();
    if (selected.length === 0) return alert("Please select at least one division.");

    openPrintPreviewModal('divisions', selected);
};

window.printSelectedBunks = function() {
    const selected = getSelectedBunks();
    if (selected.length === 0) return alert("Please select at least one bunk.");

    openPrintPreviewModal('bunks', selected);
};

window.printSelectedLocations = function() {
    const selected = getSelectedLocations();
    if (selected.length === 0) return alert("Please select at least one location.");

    openPrintPreviewModal('locations', selected);
};

// =========================================================================
// EXPORT TO EXCEL (legacy support - direct export without preview)
// =========================================================================

function downloadXLS(htmlContent, fileName) {
    const blob = new Blob(['<html xmlns:x="urn:schemas-microsoft-com:office:excel">' + htmlContent + '</html>'], { type: 'application/vnd.ms-excel' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

window.exportAllDivisionsToExcel = function() {
    const app1 = window.loadGlobalSettings?.().app1 || {};
    const allDivs = app1.availableDivisions || [];
    if (allDivs.length === 0) return alert("No divisions found.");

    let fullHtml = "";
    allDivs.forEach(div => fullHtml += generateDivisionHTML(div));
    downloadXLS(fullHtml, `Schedule_All_${window.currentScheduleDate}.xls`);
};

window.exportSelectedDivisionsToExcel = function() {
    const selected = getSelectedDivisions();
    if (selected.length === 0) return alert("Please select at least one division.");

    let fullHtml = "";
    selected.forEach(div => fullHtml += generateDivisionHTML(div));
    downloadXLS(fullHtml, `Schedule_Divisions_${window.currentScheduleDate}.xls`);
};

window.exportSelectedBunksToExcel = function() {
    const selected = getSelectedBunks();
    if (selected.length === 0) return alert("Please select at least one bunk.");

    let fullHtml = "";
    selected.forEach(bunk => fullHtml += generateBunkHTML(bunk));
    downloadXLS(fullHtml, `Schedule_Bunks_${window.currentScheduleDate}.xls`);
};

window.exportSelectedLocationsToExcel = function() {
    const selected = getSelectedLocations();
    if (selected.length === 0) return alert("Please select at least one location.");

    let fullHtml = "";
    selected.forEach(loc => fullHtml += generateLocationHTML(loc));
    downloadXLS(fullHtml, `Schedule_Locations_${window.currentScheduleDate}.xls`);
};

function triggerPrint(content) {
    const area = document.getElementById("printable-area");
    area.innerHTML = content;
    window.print();
}

window.initPrintCenter = initPrintCenter;

})();
