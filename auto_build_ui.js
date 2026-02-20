// =================================================================
// auto_build_ui.js — Auto Build Mode UI for Master Schedule Builder
// v1.0
// =================================================================
// Adds an "Auto Build" mode toggle to the Master Schedule Builder
// sidebar. When active, replaces the tile palette with a form-based
// constraint planner.
//
// DEPENDS ON:
//   - auto_build_engine.js (AutoBuildEngine)
//   - master_schedule_builder.js (MasterSchedulerInternal)
//   - auto_build_styles.css
//
// LOAD ORDER: After master_schedule_builder.js and auto_build_engine.js
// =================================================================
(function() {
'use strict';

// =================================================================
// STATE
// =================================================================
let buildMode = 'manual'; // 'manual' or 'auto'
let _configs = {};         // keyed by division name or '_base'
let _selectedTab = '_base';
const AB_STORAGE_KEY = 'campistry_autobuild_configs';

// =================================================================
// PERSISTENCE
// =================================================================
function saveConfigsToStorage() {
    try {
        localStorage.setItem(AB_STORAGE_KEY, JSON.stringify(_configs));
    } catch (e) { console.warn('[AutoBuild] Save failed:', e); }
}

function loadConfigsFromStorage() {
    try {
        const raw = localStorage.getItem(AB_STORAGE_KEY);
        if (raw) _configs = JSON.parse(raw);
    } catch (e) { /* ignore */ }
}

// =================================================================
// CONFIG MANAGEMENT
// =================================================================
function getDefaultFixedEvents(divData) {
    const divEnd = divData?.endTime || '4:30pm';
    return [
        { id: 'f_lunch', event: 'Lunch', duration: 20, earliest: '11:30am', latest: '1:30pm', type: 'fixed' },
        { id: 'f_snack', event: 'Snacks', duration: 10, earliest: '2:30pm', latest: '3:30pm', type: 'fixed' },
        { id: 'f_dismiss', event: 'Dismissal', duration: 20, earliest: divEnd, latest: divEnd, type: 'wall' },
    ];
}

function ensureConfig(key) {
    if (!_configs[key]) {
        const divisions = getDivisions();
        const divData = key === '_base' ? (Object.values(divisions)[0] || {}) : (divisions[key] || {});
        _configs[key] = {
            blocks: [
                { id: 'b1', type: 'sports', count: 2, constraint: null, constraintType: 'none', duration: null },
                { id: 'b2', type: 'special', count: 1, constraint: null, constraintType: 'none', duration: null },
                { id: 'b3', type: 'activity', count: 1, constraint: null, constraintType: 'none', duration: null },
            ],
            fixedEvents: getDefaultFixedEvents(divData),
            availabilities: [],
            defaultDuration: 50,
        };
    }
    return _configs[key];
}

function getActiveConfig() {
    if (_selectedTab !== '_base' && _configs[_selectedTab]) {
        return _configs[_selectedTab];
    }
    return ensureConfig('_base');
}

function getDivisions() {
    return window.divisions || window.loadGlobalSettings?.()?.app1?.divisions || {};
}

function getDivisionNames() {
    return Object.keys(getDivisions()).sort((a, b) => {
        const na = parseInt(a), nb = parseInt(b);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return a.localeCompare(b);
    });
}

// =================================================================
// TYPE METADATA
// =================================================================
const TYPE_COLORS = {
    activity: '#93c5fd', sports: '#86efac', special: '#c4b5fd',
    league: '#fca5a5', specialty_league: '#fda4af', swim: '#67e8f9',
    smart: '#7dd3fc', split: '#fdba74', elective: '#f0abfc'
};

const TYPE_LABELS = {
    activity: 'Activity', sports: 'Sports', special: 'Special',
    league: 'League', specialty_league: 'Spec. League', swim: 'Swim',
    smart: 'Smart', split: 'Split', elective: 'Elective'
};

const BLOCK_TYPE_OPTIONS = ['activity', 'sports', 'special', 'league', 'specialty_league', 'swim'];

// =================================================================
// HOOK INTO MASTER SCHEDULER
// =================================================================
function hookIntoMasterScheduler() {
    const MSI = window.MasterSchedulerInternal;
    if (!MSI) {
        console.warn('[AutoBuild] MasterSchedulerInternal not found — retrying...');
        setTimeout(hookIntoMasterScheduler, 500);
        return;
    }

    // Replace the sidebar header rendering
    const origInit = window.initMasterScheduler;
    if (origInit && !origInit._autoBuildHooked) {
        window.initMasterScheduler = function() {
            origInit.apply(this, arguments);
            // After init, inject our mode toggle into the sidebar header
            injectModeToggle();
        };
        window.initMasterScheduler._autoBuildHooked = true;
    }

    // If MS is already initialized, inject now
    if (document.querySelector('.ms-sidebar-header')) {
        injectModeToggle();
    }
}

// =================================================================
// MODE TOGGLE INJECTION
// =================================================================
function injectModeToggle() {
    const header = document.querySelector('.ms-sidebar-header');
    if (!header) return;

    // Don't double-inject
    if (header.querySelector('#ab-mode-toggle')) return;

    const h3 = header.querySelector('h3');
    if (!h3) return;

    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'ab-mode-toggle';
    toggleBtn.className = buildMode === 'auto' ? 'ms-btn ms-btn-primary' : 'ms-btn ms-btn-ghost';
    toggleBtn.style.cssText = 'padding:4px 8px; font-size:10px; min-height:unset; position:absolute; right:12px; top:50%; transform:translateY(-50%);';
    toggleBtn.textContent = buildMode === 'manual' ? '⚡ Auto' : '✋ Manual';
    toggleBtn.onclick = toggleMode;

    header.style.position = 'relative';
    header.appendChild(toggleBtn);
}

function toggleMode() {
    buildMode = buildMode === 'manual' ? 'auto' : 'manual';

    const header = document.querySelector('.ms-sidebar-header');
    const palette = document.getElementById('scheduler-palette');
    const toggleBtn = document.getElementById('ab-mode-toggle');

    if (header) {
        const h3 = header.querySelector('h3');
        if (h3) h3.textContent = buildMode === 'manual' ? 'Tile Types' : 'Auto Build';
    }

    if (toggleBtn) {
        toggleBtn.textContent = buildMode === 'manual' ? '⚡ Auto' : '✋ Manual';
        toggleBtn.className = buildMode === 'auto' ? 'ms-btn ms-btn-primary' : 'ms-btn ms-btn-ghost';
        toggleBtn.style.cssText = 'padding:4px 8px; font-size:10px; min-height:unset; position:absolute; right:12px; top:50%; transform:translateY(-50%);';
    }

    if (buildMode === 'manual') {
        // Restore original palette
        if (window.MasterSchedulerInternal?.renderPalette) {
            window.MasterSchedulerInternal.renderPalette();
        } else {
            // Fallback: re-init
            window.initMasterScheduler?.();
        }
    } else {
        renderAutoBuildPanel();
    }
}

// =================================================================
// MODAL HELPER (uses MS modal system)
// =================================================================
function showModal(config) {
    // Use the master scheduler's modal if available
    if (window.MasterSchedulerInternal?.showModal) {
        return window.MasterSchedulerInternal.showModal(config);
    }
    // Fallback: build a simple modal
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.id = 'ab-modal-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(15,23,42,0.5);display:flex;align-items:center;justify-content:center;z-index:10000;';

        const modal = document.createElement('div');
        modal.style.cssText = 'background:#fff;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,0.3);min-width:280px;max-width:460px;width:95%;max-height:80vh;overflow:hidden;';

        let fieldsHtml = '';
        const fieldGetters = {};

        (config.fields || []).forEach(field => {
            if (field.type === 'text') {
                fieldsHtml += `<div style="margin-bottom:14px;">
                    <label style="display:block;font-size:12px;font-weight:500;color:#475569;margin-bottom:4px;">${field.label}</label>
                    <input type="text" data-field="${field.name}" value="${field.default || ''}" placeholder="${field.placeholder || ''}"
                           style="width:100%;padding:8px 10px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;box-sizing:border-box;">
                </div>`;
            } else if (field.type === 'select') {
                const opts = (field.options || []).map(o => {
                    const val = typeof o === 'object' ? o.value : o;
                    const label = typeof o === 'object' ? o.label : o;
                    const sel = val === field.default ? ' selected' : '';
                    return `<option value="${val}"${sel}>${label}</option>`;
                }).join('');
                fieldsHtml += `<div style="margin-bottom:14px;">
                    <label style="display:block;font-size:12px;font-weight:500;color:#475569;margin-bottom:4px;">${field.label}</label>
                    <select data-field="${field.name}" style="width:100%;padding:8px 10px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;">
                        ${opts}
                    </select>
                </div>`;
            }
        });

        modal.innerHTML = `
            <div style="padding:16px 20px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;justify-content:space-between;">
                <h3 style="margin:0;font-size:16px;font-weight:600;color:#0f172a;">${config.title || 'Input'}</h3>
                <button id="ab-modal-close" style="background:none;border:none;font-size:20px;color:#94a3b8;cursor:pointer;">&times;</button>
            </div>
            <div style="padding:20px;overflow-y:auto;max-height:50vh;">
                ${config.description ? `<p style="margin:0 0 16px;font-size:13px;color:#64748b;line-height:1.5;">${config.description}</p>` : ''}
                ${fieldsHtml}
            </div>
            <div style="padding:12px 20px;border-top:1px solid #e2e8f0;display:flex;justify-content:flex-end;gap:10px;background:#f8fafc;">
                <button id="ab-modal-cancel" class="ms-btn ms-btn-ghost">Cancel</button>
                <button id="ab-modal-confirm" class="ms-btn ms-btn-primary">Confirm</button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        const close = (val) => { overlay.remove(); resolve(val); };

        overlay.querySelector('#ab-modal-close').onclick = () => close(null);
        overlay.querySelector('#ab-modal-cancel').onclick = () => close(null);
        overlay.onclick = (e) => { if (e.target === overlay) close(null); };

        overlay.querySelector('#ab-modal-confirm').onclick = () => {
            const result = {};
            modal.querySelectorAll('[data-field]').forEach(el => {
                result[el.dataset.field] = el.value;
            });
            close(result);
        };

        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') overlay.querySelector('#ab-modal-confirm').click();
            if (e.key === 'Escape') close(null);
        });

        setTimeout(() => {
            const first = modal.querySelector('input, select');
            if (first) first.focus();
        }, 50);
    });
}

// =================================================================
// RENDER AUTO BUILD PANEL
// =================================================================
function renderAutoBuildPanel() {
    const paletteEl = document.getElementById('scheduler-palette');
    if (!paletteEl) return;

    loadConfigsFromStorage();
    ensureConfig('_base');
    const config = getActiveConfig();
    const divNames = getDivisionNames();

    // ── Division tabs ──
    const divTabsHtml = `
        <div class="ab-div-tabs">
            <div class="ab-div-tab ${_selectedTab === '_base' ? 'active' : ''}" data-tab="_base">Base</div>
            ${divNames.map(d => {
                const hasOverride = !!_configs[d];
                return `<div class="ab-div-tab ${_selectedTab === d ? 'active' : ''} ${hasOverride ? 'has-override' : ''}" data-tab="${d}">${d}</div>`;
            }).join('')}
        </div>
    `;

    // ── Block list ──
    const blocksHtml = config.blocks.map((block, idx) => {
        const cLabel = block.constraintType === 'hard' ? 'MUST' : block.constraintType === 'soft' ? 'TRY' : '';
        const cClass = block.constraintType === 'hard' ? 'ab-constraint-hard' : block.constraintType === 'soft' ? 'ab-constraint-soft' : '';
        const durLabel = block.duration ? `${block.duration}m` : '';
        return `
            <div class="ab-block-item" data-idx="${idx}">
                <div class="ab-block-color" style="background:${TYPE_COLORS[block.type] || '#e2e8f0'}"></div>
                <div class="ab-block-info">
                    <span class="ab-block-type">${TYPE_LABELS[block.type] || block.type}</span>
                    <span class="ab-block-count">&times;${block.count}</span>
                    ${durLabel ? `<span class="ab-block-dur">${durLabel}</span>` : ''}
                </div>
                <div class="ab-block-controls">
                    <input type="number" class="ab-count-input" value="${block.count}" min="1" max="10" data-idx="${idx}" title="Count">
                    <button class="ab-time-btn" data-idx="${idx}" title="Time constraint">🕐</button>
                    <button class="ab-remove-btn" data-idx="${idx}" title="Remove">&times;</button>
                </div>
                ${block.constraint ? `<div class="ab-time-tag">${block.constraint.start} – ${block.constraint.end}</div>` : ''}
                ${cLabel ? `<div class="ab-constraint-tag ${cClass}">${cLabel}</div>` : ''}
            </div>`;
    }).join('') || '<div class="ab-empty-msg">No blocks — add some below</div>';

    // ── Fixed events ──
    const fixedHtml = config.fixedEvents.map((ev, idx) => `
        <div class="ab-fixed-item" data-idx="${idx}">
            <span class="ab-fixed-icon">${ev.type === 'wall' ? '🚪' : '📌'}</span>
            <div class="ab-fixed-info">
                <div class="ab-fixed-name">${ev.event}</div>
                <div class="ab-fixed-time">${ev.duration}min</div>
                <div class="ab-fixed-bounds">${ev.earliest}${ev.earliest !== ev.latest ? ' → ' + ev.latest : ''}</div>
            </div>
            <div class="ab-fixed-controls">
                <button class="ab-fixed-edit" data-idx="${idx}" title="Edit">✏️</button>
                <button class="ab-fixed-remove" data-idx="${idx}" title="Remove">&times;</button>
            </div>
        </div>
    `).join('');

    // ── Availability windows ──
    const availHtml = config.availabilities.length > 0
        ? config.availabilities.map((av, idx) => `
            <div class="ab-avail-item" data-idx="${idx}">
                <span class="ab-avail-name">${av.name}</span>
                <span class="ab-avail-window">${av.start} – ${av.end}</span>
                ${av.days?.length ? `<span class="ab-avail-days">${av.days.join(',')}</span>` : ''}
                <button class="ab-avail-remove" data-idx="${idx}">&times;</button>
            </div>
        `).join('')
        : '<div class="ab-empty-msg">None — all activities available anytime</div>';

    // ── Assemble panel ──
    paletteEl.innerHTML = `
        <div class="ab-panel">
            ${divTabsHtml}

            <div class="ab-section">
                <label class="ab-label">Activity Blocks</label>
                <div class="ab-block-list">${blocksHtml}</div>
                <div class="ab-add-row">
                    <select id="ab-add-type" class="ab-select">
                        ${BLOCK_TYPE_OPTIONS.map(t => `<option value="${t}">${TYPE_LABELS[t]}</option>`).join('')}
                    </select>
                    <button id="ab-add-block-btn" class="ab-btn ab-btn-primary">+</button>
                </div>
            </div>

            <div class="ab-section">
                <label class="ab-label">Fixed Events <span style="font-weight:400;color:#94a3b8;">(flexible timing)</span></label>
                <div class="ab-fixed-list">${fixedHtml}</div>
                <button id="ab-add-fixed-btn" class="ab-btn ab-btn-ghost" style="width:100%;">+ Add Fixed Event</button>
            </div>

            <div class="ab-section">
                <label class="ab-label">Availability Windows</label>
                <div class="ab-avail-list">${availHtml}</div>
                <button id="ab-add-avail-btn" class="ab-btn ab-btn-ghost" style="width:100%;">+ Add Availability</button>
            </div>

            <div class="ab-section">
                <label class="ab-label">Default Duration</label>
                <div style="display:flex;align-items:center;gap:4px;">
                    <input type="number" id="ab-default-duration" class="ab-input-sm" value="${config.defaultDuration}" min="15" max="120" step="5">
                    <span style="font-size:10px;color:#64748b;">min</span>
                </div>
            </div>

            <div class="ab-build-group">
                <button id="ab-build-btn" class="ab-btn ab-btn-success ab-btn-lg">⚡ Build Skeleton</button>
                <button id="ab-build-fill-btn" class="ab-btn ab-btn-primary ab-btn-md">⚡ Build + Run Optimizer</button>
                ${_selectedTab !== '_base' ? `<button id="ab-clear-override-btn" class="ab-btn ab-btn-ghost ab-btn-sm">Reset to Base</button>` : ''}
                <div id="ab-result-area"></div>
            </div>
        </div>
    `;

    wireEvents();
}

// =================================================================
// WIRE ALL EVENTS
// =================================================================
function wireEvents() {
    const config = getActiveConfig();

    // Division tabs
    document.querySelectorAll('.ab-div-tab').forEach(tab => {
        tab.onclick = () => {
            _selectedTab = tab.dataset.tab;
            if (_selectedTab !== '_base') ensureConfig(_selectedTab);
            renderAutoBuildPanel();
        };
    });

    // Block count inputs
    document.querySelectorAll('.ab-count-input').forEach(input => {
        input.onchange = () => {
            config.blocks[parseInt(input.dataset.idx)].count = Math.max(1, parseInt(input.value) || 1);
            saveConfigsToStorage();
        };
    });

    // Block time constraint buttons
    document.querySelectorAll('.ab-time-btn').forEach(btn => {
        btn.onclick = async () => {
            const idx = parseInt(btn.dataset.idx);
            const block = config.blocks[idx];
            const result = await showModal({
                title: 'Time Constraint',
                description: 'Hard = MUST be in this window (fails if impossible). Soft = prefer this window but will flex to fit.',
                fields: [
                    { name: 'constraintType', label: 'Constraint Type', type: 'select',
                      options: [
                          { value: 'none', label: 'None (anytime)' },
                          { value: 'hard', label: 'Hard — must be in window' },
                          { value: 'soft', label: 'Soft — prefer this window' }
                      ],
                      default: block.constraintType || 'none' },
                    { name: 'start', label: 'Earliest Start', type: 'text', placeholder: 'e.g., 1:00pm', default: block.constraint?.start || '' },
                    { name: 'end', label: 'Latest End', type: 'text', placeholder: 'e.g., 3:00pm', default: block.constraint?.end || '' },
                    { name: 'duration', label: 'Duration (min, blank for default)', type: 'text', placeholder: 'e.g., 60', default: block.duration ? String(block.duration) : '' },
                ]
            });
            if (!result) return;
            block.constraintType = result.constraintType;
            if (result.constraintType !== 'none' && result.start && result.end) {
                block.constraint = { start: result.start, end: result.end };
            } else {
                block.constraint = null;
                block.constraintType = 'none';
            }
            block.duration = result.duration ? parseInt(result.duration) : null;
            saveConfigsToStorage();
            renderAutoBuildPanel();
        };
    });

    // Block remove buttons
    document.querySelectorAll('.ab-remove-btn').forEach(btn => {
        btn.onclick = () => {
            config.blocks.splice(parseInt(btn.dataset.idx), 1);
            saveConfigsToStorage();
            renderAutoBuildPanel();
        };
    });

    // Add block
    document.getElementById('ab-add-block-btn').onclick = () => {
        const type = document.getElementById('ab-add-type').value;
        config.blocks.push({
            id: 'b' + Date.now(),
            type,
            count: 1,
            constraint: null,
            constraintType: 'none',
            duration: null
        });
        saveConfigsToStorage();
        renderAutoBuildPanel();
    };

    // Fixed event edit
    document.querySelectorAll('.ab-fixed-edit').forEach(btn => {
        btn.onclick = async () => {
            const idx = parseInt(btn.dataset.idx);
            const ev = config.fixedEvents[idx];
            const result = await showModal({
                title: 'Edit Fixed Event',
                description: 'Set the duration and time window. The engine finds the best placement within these bounds.',
                fields: [
                    { name: 'event', label: 'Event Name', type: 'text', default: ev.event },
                    { name: 'duration', label: 'Duration (minutes)', type: 'text', default: String(ev.duration) },
                    { name: 'earliest', label: 'No Earlier Than', type: 'text', default: ev.earliest, placeholder: 'e.g., 11:30am' },
                    { name: 'latest', label: 'No Later Than (end)', type: 'text', default: ev.latest, placeholder: 'e.g., 1:30pm' },
                    { name: 'eventType', label: 'Type', type: 'select',
                      options: [{ value: 'fixed', label: 'Fixed (Lunch, Snack)' }, { value: 'wall', label: 'Wall (Dismissal)' }],
                      default: ev.type || 'fixed' },
                ]
            });
            if (!result) return;
            ev.event = result.event || ev.event;
            ev.duration = parseInt(result.duration) || ev.duration;
            ev.earliest = result.earliest || ev.earliest;
            ev.latest = result.latest || ev.latest;
            ev.type = result.eventType || ev.type;
            saveConfigsToStorage();
            renderAutoBuildPanel();
        };
    });

    // Fixed event remove
    document.querySelectorAll('.ab-fixed-remove').forEach(btn => {
        btn.onclick = () => {
            config.fixedEvents.splice(parseInt(btn.dataset.idx), 1);
            saveConfigsToStorage();
            renderAutoBuildPanel();
        };
    });

    // Add fixed event
    document.getElementById('ab-add-fixed-btn').onclick = async () => {
        const result = await showModal({
            title: 'Add Fixed Event',
            description: 'Fixed events have a set duration but flexible placement within a time window.',
            fields: [
                { name: 'event', label: 'Event Name', type: 'text', placeholder: 'e.g., Lunch, Assembly' },
                { name: 'duration', label: 'Duration (minutes)', type: 'text', placeholder: '20' },
                { name: 'earliest', label: 'No Earlier Than', type: 'text', placeholder: 'e.g., 11:30am' },
                { name: 'latest', label: 'No Later Than (end)', type: 'text', placeholder: 'e.g., 1:30pm' },
                { name: 'eventType', label: 'Type', type: 'select',
                  options: [{ value: 'fixed', label: 'Fixed (Lunch, Snack)' }, { value: 'wall', label: 'Wall (Dismissal)' }] },
            ]
        });
        if (!result || !result.event?.trim()) return;
        config.fixedEvents.push({
            id: 'f' + Date.now(),
            event: result.event.trim(),
            duration: parseInt(result.duration) || 20,
            earliest: result.earliest || '9:00am',
            latest: result.latest || '4:00pm',
            type: result.eventType || 'fixed'
        });
        saveConfigsToStorage();
        renderAutoBuildPanel();
    };

    // Availability remove
    document.querySelectorAll('.ab-avail-remove').forEach(btn => {
        btn.onclick = () => {
            config.availabilities.splice(parseInt(btn.dataset.idx), 1);
            saveConfigsToStorage();
            renderAutoBuildPanel();
        };
    });

    // Add availability
    document.getElementById('ab-add-avail-btn').onclick = async () => {
        const settings = window.loadGlobalSettings?.() || {};
        const specials = (settings.app1?.specialActivities || []).map(s => s.name);
        const fieldActs = (settings.app1?.fields || []).flatMap(f => (f.activities || []));
        const allNames = [...new Set([...specials, ...fieldActs])].sort();

        const nameOptions = allNames.length > 0
            ? allNames.map(n => ({ value: n, label: n }))
            : [{ value: '', label: '(no activities configured)' }];

        const result = await showModal({
            title: 'Add Availability Window',
            description: 'When a specific activity is only available during certain hours, the engine schedules around it. Example: "Activity Master available 11:20am-12:20pm"',
            fields: [
                { name: 'name', label: 'Activity / Special', type: 'select', options: nameOptions },
                { name: 'start', label: 'Available From', type: 'text', placeholder: 'e.g., 11:20am' },
                { name: 'end', label: 'Available Until', type: 'text', placeholder: 'e.g., 12:20pm' },
                { name: 'days', label: 'Days (blank = every day)', type: 'text', placeholder: 'e.g., Tue,Wed' },
            ]
        });
        if (!result || !result.name) return;
        config.availabilities.push({
            name: result.name,
            start: result.start || '9:00am',
            end: result.end || '4:00pm',
            days: result.days ? result.days.split(',').map(d => d.trim()).filter(Boolean) : []
        });
        saveConfigsToStorage();
        renderAutoBuildPanel();
    };

    // Duration input
    const durInput = document.getElementById('ab-default-duration');
    if (durInput) durInput.onchange = () => {
        config.defaultDuration = parseInt(durInput.value) || 50;
        saveConfigsToStorage();
    };

    // Clear override
    const clearBtn = document.getElementById('ab-clear-override-btn');
    if (clearBtn) clearBtn.onclick = () => {
        delete _configs[_selectedTab];
        saveConfigsToStorage();
        renderAutoBuildPanel();
    };

    // BUILD buttons
    document.getElementById('ab-build-btn').onclick = () => executeBuild(false);
    document.getElementById('ab-build-fill-btn').onclick = () => executeBuild(true);
}

// =================================================================
// EXECUTE BUILD
// =================================================================
function executeBuild(alsoRunOptimizer) {
    const Engine = window.AutoBuildEngine;
    if (!Engine) {
        showResult('error', 'AutoBuildEngine not loaded. Check script order.');
        return;
    }

    const MSI = window.MasterSchedulerInternal;
    if (!MSI) {
        showResult('error', 'MasterSchedulerInternal not available.');
        return;
    }

    const divisions = getDivisions();
    const divNames = getDivisionNames();

    if (divNames.length === 0) {
        showResult('error', 'No divisions configured. Go to Setup first.');
        return;
    }

    // Get current day for availability filtering
    const dateStr = window.currentScheduleDate || '';
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    let currentDay = '';
    if (dateStr) {
        const [Y, M, D] = dateStr.split('-').map(Number);
        if (Y && M && D) currentDay = dayNames[new Date(Y, M - 1, D).getDay()];
    }

    showResult('progress', 'Building...');

    // Small delay for UI to update
    setTimeout(() => {
        const newSkeleton = [];
        const allWarnings = [];

        divNames.forEach(divName => {
            const config = _configs[divName] || _configs['_base'];
            if (!config) { allWarnings.push(`${divName}: no config`); return; }

            const divData = divisions[divName] || {};
            const dayStartMin = Engine.parseTime(divData.startTime || '9:00am');
            const dayEndMin = Engine.parseTime(divData.endTime || '4:30pm');

            // Validate first
            const errors = Engine.validateConfig(config, dayStartMin, dayEndMin);
            if (errors.length > 0) {
                allWarnings.push(...errors.map(e => `${divName}: ${e}`));
            }

            // Solve
            const result = Engine.solveSchedule(config, divName, dayStartMin, dayEndMin, currentDay);

            if (result.warnings?.length) {
                allWarnings.push(...result.warnings.map(w => `${divName}: ${w}`));
            }

            // Convert to skeleton blocks
            result.placements.forEach(p => {
                newSkeleton.push({
                    id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 6),
                    type: p.skeletonType === 'pinned' ? 'pinned' : (p.skeletonType || 'slot'),
                    event: p.event,
                    division: divName,
                    startTime: Engine.fmtTime(p.startMin),
                    endTime: Engine.fmtTime(p.endMin),
                    ...p.extra
                });
            });
        });

        // Apply to master scheduler
        MSI.setSkeleton(newSkeleton);
        MSI.markUnsavedChanges();
        MSI.saveDraftToLocalStorage();
        MSI.renderGrid();

        // Show result
        if (allWarnings.length > 0) {
            showResult('warning', `Built with ${allWarnings.length} warning(s):\n${allWarnings.slice(0, 5).map(w => '• ' + w).join('\n')}${allWarnings.length > 5 ? `\n...and ${allWarnings.length - 5} more` : ''}`);
        } else {
            showResult('success', `✓ Skeleton built: ${newSkeleton.length} blocks across ${divNames.length} division(s)`);
        }

        // Optionally run optimizer
        if (alsoRunOptimizer) {
            setTimeout(() => {
                const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
                window.saveCurrentDailyData?.('manualSkeleton', newSkeleton);

                if (typeof window.runSkeletonOptimizer === 'function') {
                    window.runSkeletonOptimizer(newSkeleton);
                    showResult('success', '⚡ Optimizer running...');
                }
            }, 300);
        }
    }, 50);
}

function showResult(type, message) {
    const area = document.getElementById('ab-result-area');
    if (!area) return;

    if (type === 'progress') {
        area.innerHTML = '<div class="ab-progress"><div class="ab-progress-bar" style="width:50%"></div></div>';
        return;
    }

    const cls = type === 'success' ? 'ab-result-success' : type === 'warning' ? 'ab-result-warning' : 'ab-result-error';
    area.innerHTML = `<div class="ab-result-msg ${cls}">${message.replace(/\n/g, '<br>')}</div>`;
}

// =================================================================
// INITIALIZATION
// =================================================================
function init() {
    loadConfigsFromStorage();
    hookIntoMasterScheduler();

    // Re-hook when MS tab is activated
    const observer = new MutationObserver(() => {
        const header = document.querySelector('.ms-sidebar-header');
        if (header && !header.querySelector('#ab-mode-toggle')) {
            injectModeToggle();
            if (buildMode === 'auto') {
                renderAutoBuildPanel();
            }
        }
    });

    const msContent = document.getElementById('master-scheduler-content');
    if (msContent) {
        observer.observe(msContent, { childList: true, subtree: true });
    }
}

// Run when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    // Small delay to ensure MS is loaded
    setTimeout(init, 200);
}

// =================================================================
// PUBLIC API
// =================================================================
window.AutoBuildUI = {
    toggleMode,
    renderPanel: renderAutoBuildPanel,
    getConfigs: () => _configs,
    setConfig: (key, config) => { _configs[key] = config; saveConfigsToStorage(); },
    getMode: () => buildMode,
};

})();
