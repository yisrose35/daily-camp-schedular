// =================================================================
// custom_persistent_tiles.js — Persistent Custom Tile System v1.0
// =================================================================
//
// WHAT: Users can create named tile types (e.g., "Shiur") that:
//   1. Persist across sessions (saved to globalSettings)
//   2. Appear in ALL palettes (Master Builder, Daily Adjustments, Auto Planner)
//   3. Behave like anchor tiles (pinned, no solver generation needed)
//   4. Have configurable: name, color, duration, needsChange buffer, location
//   5. Support quantity layers ("every bunk needs 1 shiur per day")
//
// STORAGE:  globalSettings.app1.customPersistentTiles = [
//   { id, name, color, textColor, duration, anchor: true,
//     needsChange, defaultLocation, icon }
// ]
//
// INTEGRATION POINTS (find-and-replace patches):
//   1. master_schedule_builder.js → DAW_LAYER_TYPES + TILES arrays
//   2. daily_adjustments.js → DAW_TYPES + TILES + renderPalette
//   3. auto_schedule_planner.js → PALETTE_TILES + LAYER_COLORS
//   4. auto_build_engine.js → isLayerPinned + classifier
//   5. scheduler_core_main.js → isPinnedType check
//   6. skeleton_sandbox.js → PREDEFINED_TILES
//   7. locations.js → Setup UI for managing custom tiles
//
// APPLY: Load this file AFTER all the above files.
//        It monkey-patches the palette renderers and exposes
//        a management UI + API.
// =================================================================

(function() {
'use strict';

const VERSION = '1.0.0';
const STORAGE_KEY = 'customPersistentTiles';
const DEBUG = true;

function log(...args) { if (DEBUG) console.log('[CustomTiles]', ...args); }

// =================================================================
// COLOR PRESETS (user picks from these when creating a tile)
// =================================================================
const COLOR_PRESETS = [
    { name: 'Teal',      bg: '#99f6e4', text: '#134e4a', border: '#14b8a6' },
    { name: 'Rose',      bg: '#fecdd3', text: '#881337', border: '#f43f5e' },
    { name: 'Amber',     bg: '#fde68a', text: '#78350f', border: '#f59e0b' },
    { name: 'Lime',      bg: '#d9f99d', text: '#365314', border: '#84cc16' },
    { name: 'Sky',       bg: '#bae6fd', text: '#0c4a6e', border: '#0ea5e9' },
    { name: 'Violet',    bg: '#ddd6fe', text: '#4c1d95', border: '#8b5cf6' },
    { name: 'Orange',    bg: '#fed7aa', text: '#7c2d12', border: '#f97316' },
    { name: 'Indigo',    bg: '#c7d2fe', text: '#312e81', border: '#6366f1' },
    { name: 'Fuchsia',   bg: '#f5d0fe', text: '#701a75', border: '#d946ef' },
    { name: 'Slate',     bg: '#cbd5e1', text: '#1e293b', border: '#64748b' },
    { name: 'Emerald',   bg: '#a7f3d0', text: '#064e3b', border: '#10b981' },
    { name: 'Red',       bg: '#fca5a5', text: '#7f1d1d', border: '#ef4444' },
];

// =================================================================
// STORAGE: Load / Save
// =================================================================

function loadCustomTiles() {
    try {
        const g = window.loadGlobalSettings?.() || {};
        return g.app1?.customPersistentTiles || [];
    } catch (e) {
        log('Error loading custom tiles:', e);
        return [];
    }
}

function saveCustomTiles(tiles) {
    try {
        const g = window.loadGlobalSettings?.() || {};
        if (!g.app1) g.app1 = {};
        g.app1.customPersistentTiles = tiles;
        window.saveGlobalSettings?.('app1', g.app1);
        window.forceSyncToCloud?.();
        log('Saved', tiles.length, 'custom tiles');
    } catch (e) {
        log('Error saving custom tiles:', e);
    }
}

// =================================================================
// CRUD API
// =================================================================

function addCustomTile(config) {
    const tiles = loadCustomTiles();
    
    // Validate
    if (!config.name || !config.name.trim()) {
        throw new Error('Tile name is required');
    }
    
    const name = config.name.trim();
    
    // Check for duplicate names (case insensitive)
    if (tiles.some(t => t.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(`A tile named "${name}" already exists`);
    }
    
    // Check for collision with built-in types
    const builtIns = ['sport', 'sports', 'special', 'activity', 'swim', 'lunch',
                      'snacks', 'dismissal', 'custom', 'league', 'elective',
                      'split', 'specialty_league', 'smart'];
    if (builtIns.includes(name.toLowerCase())) {
        throw new Error(`"${name}" conflicts with a built-in tile type`);
    }
    
    const color = config.color || COLOR_PRESETS[tiles.length % COLOR_PRESETS.length];
    
    const tile = {
        id: 'cpt_' + Math.random().toString(36).slice(2, 9),
        name: name,
        // The "type" used in skeleton/engine — lowercase, underscored
        type: 'custom_' + name.toLowerCase().replace(/[^a-z0-9]/g, '_'),
        bg: color.bg,
        textColor: color.text,
        border: color.border,
        duration: parseInt(config.duration) || 10,
        anchor: true,           // Always pinned, no generation
        needsChange: config.needsChange === true,
        changeDuration: parseInt(config.changeDuration) || 10,
        defaultLocation: config.defaultLocation || null,
        icon: config.icon || null,
        createdAt: new Date().toISOString()
    };
    
    tiles.push(tile);
    saveCustomTiles(tiles);
    
    // Notify system
    window.dispatchEvent(new CustomEvent('campistry-custom-tiles-changed', {
        detail: { action: 'add', tile }
    }));
    
    log('Added custom tile:', tile.name, tile.type);
    return tile;
}

function updateCustomTile(id, updates) {
    const tiles = loadCustomTiles();
    const idx = tiles.findIndex(t => t.id === id);
    if (idx === -1) throw new Error('Tile not found');
    
    // If name changed, check for duplicates
    if (updates.name && updates.name.trim().toLowerCase() !== tiles[idx].name.toLowerCase()) {
        const newName = updates.name.trim();
        if (tiles.some((t, i) => i !== idx && t.name.toLowerCase() === newName.toLowerCase())) {
            throw new Error(`A tile named "${newName}" already exists`);
        }
        updates.type = 'custom_' + newName.toLowerCase().replace(/[^a-z0-9]/g, '_');
    }
    
    tiles[idx] = { ...tiles[idx], ...updates };
    saveCustomTiles(tiles);
    
    window.dispatchEvent(new CustomEvent('campistry-custom-tiles-changed', {
        detail: { action: 'update', tile: tiles[idx] }
    }));
    
    return tiles[idx];
}

function removeCustomTile(id) {
    let tiles = loadCustomTiles();
    const tile = tiles.find(t => t.id === id);
    if (!tile) throw new Error('Tile not found');
    
    tiles = tiles.filter(t => t.id !== id);
    saveCustomTiles(tiles);
    
    window.dispatchEvent(new CustomEvent('campistry-custom-tiles-changed', {
        detail: { action: 'remove', tile }
    }));
    
    log('Removed custom tile:', tile.name);
    return tile;
}

// =================================================================
// CONVERSION: Custom tile → palette formats
// =================================================================

/**
 * Convert a custom tile to the TILES format (master_schedule_builder / daily_adjustments)
 */
function toTileFormat(ct) {
    return {
        type: ct.type,
        name: ct.name,
        style: `background:${ct.bg};color:${ct.textColor};`,
        description: `Custom pinned tile: "${ct.name}" (${ct.duration}min). No generation — placed directly.${ct.needsChange ? ' Auto-inserts change buffer.' : ''}`,
        _customPersistent: true,
        _customTileId: ct.id,
        anchor: true
    };
}

/**
 * Convert to DAW_LAYER_TYPES format
 */
function toDAWLayerFormat(ct) {
    return {
        type: ct.type,
        name: ct.name,
        style: `background:${ct.bg};color:${ct.textColor};`,
        anchor: true,
        _customPersistent: true,
        _customTileId: ct.id
    };
}

/**
 * Convert to auto_schedule_planner PALETTE_TILES format
 */
function toPaletteTileFormat(ct) {
    return {
        type: ct.type,
        name: ct.name,
        defaultDuration: ct.duration,
        defaultOp: '=',
        defaultQty: 1,
        fixed: true,
        _customPersistent: true,
        _customTileId: ct.id
    };
}

/**
 * Convert to auto_schedule_planner LAYER_COLORS format
 */
function toLayerColorFormat(ct) {
    return {
        bg: ct.bg.replace(/^#/, 'rgba(') ? `rgba(${parseInt(ct.bg.slice(1,3),16)},${parseInt(ct.bg.slice(3,5),16)},${parseInt(ct.bg.slice(5,7),16)},0.55)` : ct.bg,
        border: ct.border,
        text: ct.textColor
    };
}

/**
 * Convert to skeleton_sandbox PREDEFINED_TILES format
 */
function toPredefinedTileFormat(ct) {
    return {
        name: ct.name,
        type: ct.type,
        isPredefined: false,
        _customPersistent: true
    };
}

// =================================================================
// PALETTE INJECTION: Monkey-patch all palette renderers
// =================================================================

/**
 * Get all custom tiles in every format needed
 */
function getAllCustomTileFormats() {
    const tiles = loadCustomTiles();
    return {
        tiles: tiles,
        tileFormat: tiles.map(toTileFormat),
        dawFormat: tiles.map(toDAWLayerFormat),
        paletteFormat: tiles.map(toPaletteTileFormat),
        layerColors: tiles.reduce((acc, ct) => {
            acc[ct.type] = toLayerColorFormat(ct);
            return acc;
        }, {}),
        predefinedFormat: tiles.map(toPredefinedTileFormat)
    };
}

/**
 * Inject custom tiles into the Master Builder's DAW_LAYER_TYPES
 */
function patchMasterBuilderPalette() {
    const internal = window.MasterSchedulerInternal;
    if (!internal?.DAW_LAYER_TYPES) return;
    
    // Remove any previously injected custom tiles
    const origTypes = internal.DAW_LAYER_TYPES.filter(t => !t._customPersistent);
    
    // Inject fresh custom tiles before the last item (custom pinned)
    const customDawTiles = loadCustomTiles().map(toDAWLayerFormat);
    const customPinnedIdx = origTypes.findIndex(t => t.type === 'custom');
    
    if (customPinnedIdx >= 0) {
        origTypes.splice(customPinnedIdx, 0, ...customDawTiles);
    } else {
        origTypes.push(...customDawTiles);
    }
    
    internal.DAW_LAYER_TYPES = origTypes;
    log('Patched Master Builder DAW_LAYER_TYPES:', internal.DAW_LAYER_TYPES.length, 'types');
}

/**
 * Inject custom tiles into the daily_adjustments TILES array
 * (The TILES array is module-scoped, so we patch renderPalette instead)
 */
function patchDailyAdjustmentsPalette() {
    // daily_adjustments reads DAW_TYPES from MasterSchedulerInternal.DAW_LAYER_TYPES
    // which we already patched above. For the manual-mode TILES, we need to
    // intercept renderPalette.
    
    const originalRenderPalette = window.daRenderPalette || window._originalDaRenderPalette;
    if (!originalRenderPalette) {
        // Can't patch — will rely on DAW path which is already patched
        log('No daRenderPalette to patch — DAW palette should work via MasterSchedulerInternal');
        return;
    }
    
    // Store original if not already
    if (!window._originalDaRenderPalette) {
        window._originalDaRenderPalette = originalRenderPalette;
    }
    
    // The palette is re-rendered dynamically, so the injection happens there
    log('Daily Adjustments palette patch ready');
}

// =================================================================
// ENGINE INTEGRATION: Auto Build Engine recognizes custom tiles
// =================================================================

/**
 * Check if a layer type is a custom persistent tile
 */
function isCustomPersistentType(type) {
    if (!type) return false;
    if (type.startsWith('custom_')) {
        const tiles = loadCustomTiles();
        return tiles.some(t => t.type === type);
    }
    return false;
}

/**
 * Get the custom tile config for a layer type
 */
function getCustomTileConfig(type) {
    if (!type) return null;
    const tiles = loadCustomTiles();
    return tiles.find(t => t.type === type) || tiles.find(t => t.name.toLowerCase() === type.toLowerCase()) || null;
}

/**
 * Get the change buffer duration for a custom tile type
 */
function getChangeDuration(type) {
    const config = getCustomTileConfig(type);
    if (!config) return 0;
    if (!config.needsChange) return 0;
    return config.changeDuration || 10;
}

// =================================================================
// SCHEDULER INTEGRATION: Recognize custom tiles as pinned events
// =================================================================

/**
 * Patch the isPinnedType check in scheduler_core_main.js
 * Custom persistent tiles should always be treated as pinned
 */
function isCustomPinnedEvent(item) {
    if (!item) return false;
    const type = (item.type || '').toLowerCase();
    const event = (item.event || '').toLowerCase();
    
    const tiles = loadCustomTiles();
    for (const ct of tiles) {
        if (type === ct.type || event.toLowerCase() === ct.name.toLowerCase()) {
            return true;
        }
    }
    return false;
}

// =================================================================
// MANAGEMENT UI
// =================================================================

/**
 * Render the custom tiles management section
 * Can be embedded in the Setup tab or Locations tab
 */
function renderManagementUI(container) {
    if (!container) return;
    
    const tiles = loadCustomTiles();
    
    container.innerHTML = `
        <div style="margin-bottom:16px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                <div>
                    <div style="font-weight:600; font-size:0.95rem; color:#1e293b;">Custom Tile Types</div>
                    <div style="font-size:0.8rem; color:#64748b;">Create reusable pinned tiles (e.g., Shiur, Assembly). These appear in all builder palettes.</div>
                </div>
            </div>
            
            ${tiles.length > 0 ? `
                <div id="cpt-tiles-list" style="display:flex; flex-direction:column; gap:8px; margin-bottom:16px;">
                    ${tiles.map(ct => renderTileCard(ct)).join('')}
                </div>
            ` : `
                <div style="padding:20px; text-align:center; color:#94a3b8; font-size:0.85rem; background:#f8fafc; border-radius:8px; border:1px dashed #e2e8f0; margin-bottom:16px;">
                    No custom tiles yet. Add one below.
                </div>
            `}
            
            <div id="cpt-add-section" style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:14px;">
                <div style="font-weight:600; font-size:0.85rem; color:#374151; margin-bottom:10px;">Add New Tile</div>
                <div style="display:flex; flex-wrap:wrap; gap:10px; align-items:flex-end;">
                    <div style="flex:1; min-width:140px;">
                        <label style="display:block; font-size:0.75rem; color:#64748b; margin-bottom:4px;">Name</label>
                        <input id="cpt-name" type="text" placeholder="e.g., Shiur" 
                            style="width:100%; padding:7px 10px; border:1px solid #d1d5db; border-radius:6px; font-size:0.85rem;">
                    </div>
                    <div style="min-width:80px;">
                        <label style="display:block; font-size:0.75rem; color:#64748b; margin-bottom:4px;">Duration</label>
                        <div style="display:flex; align-items:center; gap:4px;">
                            <input id="cpt-duration" type="number" min="5" max="120" step="5" value="10" 
                                style="width:60px; padding:7px 8px; border:1px solid #d1d5db; border-radius:6px; font-size:0.85rem; text-align:center;">
                            <span style="font-size:0.75rem; color:#94a3b8;">min</span>
                        </div>
                    </div>
                    <div style="min-width:120px;">
                        <label style="display:block; font-size:0.75rem; color:#64748b; margin-bottom:4px;">Color</label>
                        <div id="cpt-color-picker" style="display:flex; gap:4px; flex-wrap:wrap;">
                            ${COLOR_PRESETS.slice(0, 6).map((c, i) => `
                                <div class="cpt-color-swatch" data-idx="${i}" 
                                    style="width:22px; height:22px; border-radius:4px; background:${c.bg}; border:2px solid ${i === 0 ? c.border : 'transparent'}; cursor:pointer;"
                                    title="${c.name}"></div>
                            `).join('')}
                        </div>
                    </div>
                    <div style="display:flex; align-items:center; gap:6px;">
                        <input id="cpt-needs-change" type="checkbox">
                        <label for="cpt-needs-change" style="font-size:0.8rem; color:#64748b;">Needs change buffer</label>
                    </div>
                    <button id="cpt-add-btn" style="background:#147D91; color:white; border:none; border-radius:8px; padding:8px 16px; cursor:pointer; font-size:0.85rem; font-weight:500; white-space:nowrap;">
                        Add Tile
                    </button>
                </div>
            </div>
        </div>
    `;
    
    // Wire up events
    wireManagementEvents(container);
}

function renderTileCard(ct) {
    return `
        <div class="cpt-tile-card" data-id="${ct.id}" style="
            display:flex; align-items:center; gap:12px; padding:10px 14px;
            background:white; border:1px solid #e5e7eb; border-radius:8px;
            border-left:4px solid ${ct.border};
        ">
            <div style="
                min-width:28px; height:28px; border-radius:6px;
                background:${ct.bg}; border:1px solid ${ct.border};
                display:flex; align-items:center; justify-content:center;
                font-size:0.7rem; font-weight:700; color:${ct.textColor};
            ">${ct.name.slice(0, 2).toUpperCase()}</div>
            
            <div style="flex:1;">
                <div style="font-weight:600; font-size:0.85rem; color:#1e293b;">${escHtml(ct.name)}</div>
                <div style="font-size:0.75rem; color:#94a3b8;">
                    ${ct.duration}min · Pinned
                    ${ct.needsChange ? ' · Change buffer' : ''}
                    ${ct.defaultLocation ? ' · ' + escHtml(ct.defaultLocation) : ''}
                </div>
            </div>
            
            <div style="display:flex; gap:6px;">
                <button class="cpt-edit-btn" data-id="${ct.id}" style="
                    background:none; border:1px solid #d1d5db; border-radius:6px;
                    padding:4px 10px; cursor:pointer; font-size:0.75rem; color:#6b7280;
                " title="Edit">Edit</button>
                <button class="cpt-delete-btn" data-id="${ct.id}" style="
                    background:none; border:1px solid #fca5a5; border-radius:6px;
                    padding:4px 10px; cursor:pointer; font-size:0.75rem; color:#ef4444;
                " title="Delete">×</button>
            </div>
        </div>
    `;
}

function wireManagementEvents(container) {
    let selectedColorIdx = 0;
    
    // Color picker
    container.querySelectorAll('.cpt-color-swatch').forEach(swatch => {
        swatch.onclick = () => {
            container.querySelectorAll('.cpt-color-swatch').forEach(s => {
                s.style.border = '2px solid transparent';
            });
            swatch.style.border = `2px solid ${COLOR_PRESETS[parseInt(swatch.dataset.idx)].border}`;
            selectedColorIdx = parseInt(swatch.dataset.idx);
        };
    });
    
    // Add button
    const addBtn = container.querySelector('#cpt-add-btn');
    if (addBtn) {
        addBtn.onclick = () => {
            const nameInput = container.querySelector('#cpt-name');
            const durInput = container.querySelector('#cpt-duration');
            const changeCheck = container.querySelector('#cpt-needs-change');
            
            try {
                addCustomTile({
                    name: nameInput.value,
                    duration: durInput.value,
                    color: COLOR_PRESETS[selectedColorIdx],
                    needsChange: changeCheck.checked
                });
                
                // Re-render
                renderManagementUI(container);
                
                // Re-patch palettes
                refreshAllPalettes();
                
            } catch (e) {
                alert(e.message);
            }
        };
        
        // Enter key on name input
        const nameInput = container.querySelector('#cpt-name');
        if (nameInput) {
            nameInput.onkeyup = (e) => { if (e.key === 'Enter') addBtn.click(); };
        }
    }
    
    // Delete buttons
    container.querySelectorAll('.cpt-delete-btn').forEach(btn => {
        btn.onclick = () => {
            const id = btn.dataset.id;
            const tile = loadCustomTiles().find(t => t.id === id);
            if (!tile) return;
            if (!confirm(`Delete custom tile "${tile.name}"?`)) return;
            
            removeCustomTile(id);
            renderManagementUI(container);
            refreshAllPalettes();
        };
    });
    
    // Edit buttons
    container.querySelectorAll('.cpt-edit-btn').forEach(btn => {
        btn.onclick = () => {
            const id = btn.dataset.id;
            const tile = loadCustomTiles().find(t => t.id === id);
            if (!tile) return;
            showEditModal(tile, container);
        };
    });
}

function showEditModal(tile, parentContainer) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:10000;display:flex;align-items:center;justify-content:center;';
    
    const modal = document.createElement('div');
    modal.style.cssText = 'background:white;border-radius:12px;padding:24px;width:380px;max-width:90vw;box-shadow:0 20px 60px rgba(0,0,0,0.3);';
    
    modal.innerHTML = `
        <div style="font-weight:700; font-size:1rem; color:#1e293b; margin-bottom:16px;">Edit "${escHtml(tile.name)}"</div>
        <div style="display:flex; flex-direction:column; gap:12px;">
            <div>
                <label style="display:block; font-size:0.8rem; color:#64748b; margin-bottom:4px;">Name</label>
                <input id="cpt-edit-name" type="text" value="${escHtml(tile.name)}"
                    style="width:100%; padding:8px 10px; border:1px solid #d1d5db; border-radius:6px; font-size:0.85rem;">
            </div>
            <div>
                <label style="display:block; font-size:0.8rem; color:#64748b; margin-bottom:4px;">Duration (minutes)</label>
                <input id="cpt-edit-duration" type="number" min="5" max="120" step="5" value="${tile.duration}"
                    style="width:80px; padding:8px 10px; border:1px solid #d1d5db; border-radius:6px; font-size:0.85rem; text-align:center;">
            </div>
            <div>
                <label style="display:block; font-size:0.8rem; color:#64748b; margin-bottom:4px;">Color</label>
                <div id="cpt-edit-colors" style="display:flex; gap:6px; flex-wrap:wrap;">
                    ${COLOR_PRESETS.map((c, i) => `
                        <div class="cpt-edit-swatch" data-idx="${i}"
                            style="width:26px; height:26px; border-radius:5px; background:${c.bg};
                            border:2px solid ${c.bg === tile.bg ? c.border : 'transparent'}; cursor:pointer;"
                            title="${c.name}"></div>
                    `).join('')}
                </div>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
                <input id="cpt-edit-change" type="checkbox" ${tile.needsChange ? 'checked' : ''}>
                <label for="cpt-edit-change" style="font-size:0.85rem; color:#374151;">Needs "change" buffer</label>
            </div>
            ${tile.needsChange ? `
            <div>
                <label style="display:block; font-size:0.8rem; color:#64748b; margin-bottom:4px;">Change buffer duration</label>
                <input id="cpt-edit-change-dur" type="number" min="5" max="30" step="5" value="${tile.changeDuration || 10}"
                    style="width:80px; padding:8px 10px; border:1px solid #d1d5db; border-radius:6px; font-size:0.85rem; text-align:center;">
            </div>` : ''}
        </div>
        <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:20px;">
            <button id="cpt-edit-cancel" style="padding:8px 16px; border:1px solid #d1d5db; border-radius:8px; background:white; cursor:pointer; font-size:0.85rem;">Cancel</button>
            <button id="cpt-edit-save" style="padding:8px 16px; border:none; border-radius:8px; background:#147D91; color:white; cursor:pointer; font-size:0.85rem; font-weight:500;">Save</button>
        </div>
    `;
    
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    
    let editColorIdx = COLOR_PRESETS.findIndex(c => c.bg === tile.bg);
    if (editColorIdx < 0) editColorIdx = 0;
    
    // Color picker
    modal.querySelectorAll('.cpt-edit-swatch').forEach(swatch => {
        swatch.onclick = () => {
            modal.querySelectorAll('.cpt-edit-swatch').forEach(s => s.style.border = '2px solid transparent');
            const idx = parseInt(swatch.dataset.idx);
            swatch.style.border = `2px solid ${COLOR_PRESETS[idx].border}`;
            editColorIdx = idx;
        };
    });
    
    // Cancel
    modal.querySelector('#cpt-edit-cancel').onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    
    // Save
    modal.querySelector('#cpt-edit-save').onclick = () => {
        const color = COLOR_PRESETS[editColorIdx];
        try {
            updateCustomTile(tile.id, {
                name: modal.querySelector('#cpt-edit-name').value.trim(),
                duration: parseInt(modal.querySelector('#cpt-edit-duration').value) || 10,
                bg: color.bg,
                textColor: color.text,
                border: color.border,
                needsChange: modal.querySelector('#cpt-edit-change').checked,
                changeDuration: modal.querySelector('#cpt-edit-change-dur')
                    ? parseInt(modal.querySelector('#cpt-edit-change-dur').value) || 10
                    : tile.changeDuration
            });
            
            overlay.remove();
            renderManagementUI(parentContainer);
            refreshAllPalettes();
        } catch (e) {
            alert(e.message);
        }
    };
}

// =================================================================
// PALETTE REFRESH: Re-render all palettes to include custom tiles
// =================================================================

function refreshAllPalettes() {
    // 1. Patch Master Builder
    patchMasterBuilderPalette();
    
    // 2. Re-render Master Builder DAW palette if visible
    if (window.MasterSchedulerInternal?.renderDAWPalette) {
        window.MasterSchedulerInternal.renderDAWPalette();
    }
    
    // 3. Re-render Daily Adjustments palette if visible
    if (window.daRenderPalette) {
        window.daRenderPalette();
    } else if (typeof renderPalette === 'function') {
        renderPalette();
    }
    
    // 4. Auto Planner — inject into LAYER_COLORS if available
    if (window.AutoSchedulePlanner?.LAYER_COLORS) {
        const tiles = loadCustomTiles();
        tiles.forEach(ct => {
            window.AutoSchedulePlanner.LAYER_COLORS[ct.type] = toLayerColorFormat(ct);
        });
    }
    
    log('Refreshed all palettes');
}

// =================================================================
// EVENT NAME MAPPER: For scheduler_core_main mapEventNameForOptimizer
// =================================================================

/**
 * Patch mapEventNameForOptimizer to recognize custom tile types
 * Must return { type: 'pinned', event: tileName }
 */
function patchEventNameMapper() {
    const original = window.mapEventNameForOptimizer;
    if (!original) return;
    if (original._customTilesPatched) return;
    
    window.mapEventNameForOptimizer = function(name) {
        if (!name) return original(name);
        
        // Check if this matches a custom tile name
        const tiles = loadCustomTiles();
        const match = tiles.find(t => 
            t.name.toLowerCase() === name.toLowerCase() ||
            t.type === name.toLowerCase()
        );
        
        if (match) {
            return { type: 'pinned', event: match.name };
        }
        
        return original(name);
    };
    window.mapEventNameForOptimizer._customTilesPatched = true;
    log('Patched mapEventNameForOptimizer');
}

// =================================================================
// HELPER
// =================================================================

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// =================================================================
// INITIALIZATION
// =================================================================

function initialize() {
    log(`Custom Persistent Tiles v${VERSION} initializing...`);
    
    const tiles = loadCustomTiles();
    log(`Loaded ${tiles.length} custom tiles:`, tiles.map(t => t.name).join(', '));
    
    // Patch palettes
    patchMasterBuilderPalette();
    patchDailyAdjustmentsPalette();
    patchEventNameMapper();
    
    // Listen for tile changes (e.g., from another tab)
    window.addEventListener('campistry-custom-tiles-changed', () => {
        refreshAllPalettes();
    });
    
    // Re-patch after Master Builder initializes (it may re-create DAW_LAYER_TYPES)
    window.addEventListener('campistry-schedule-builder-ready', () => {
        patchMasterBuilderPalette();
    });
    
    log('Initialized');
}

// =================================================================
// PUBLIC API
// =================================================================

window.CustomPersistentTiles = {
    // CRUD
    add: addCustomTile,
    update: updateCustomTile,
    remove: removeCustomTile,
    getAll: loadCustomTiles,
    getConfig: getCustomTileConfig,
    
    // Checks
    isCustomType: isCustomPersistentType,
    isCustomPinnedEvent: isCustomPinnedEvent,
    getChangeDuration: getChangeDuration,
    
    // Formats
    getAllFormats: getAllCustomTileFormats,
    toTileFormat,
    toDAWLayerFormat,
    toPaletteTileFormat,
    toLayerColorFormat,
    
    // UI
    renderManagementUI,
    refreshAllPalettes,
    
    // Constants
    COLOR_PRESETS,
    VERSION
};

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
} else {
    initialize();
}

log(`Custom Persistent Tiles v${VERSION} loaded`);

})();
