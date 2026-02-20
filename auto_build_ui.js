// =================================================================
// auto_build_ui.js — Auto Build Mode for Master Schedule Builder
// v2.0
// =================================================================
// Adds a toggle in the MS sidebar. In auto mode, shows a simple
// list of "what needs to happen today." Each item is added via a
// smart modal that asks the right questions based on type.
//
// DEPENDS ON: auto_build_engine.js, master_schedule_builder.js
// LOAD ORDER: After both dependencies
// =================================================================
(function() {
'use strict';

// =================================================================
// STATE
// =================================================================
let _active = false;  // is auto-build mode on?
let _items = [];      // the requirements list
const STORAGE_KEY = 'campistry_autobuild_items';

// Persist items
function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_items)); } catch(e) {}
}
function load() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) _items = JSON.parse(raw);
    } catch(e) {}
}

// =================================================================
// HELPERS
// =================================================================
function getDivisions() {
    return window.divisions || window.loadGlobalSettings?.()?.app1?.divisions || {};
}

function getActivityChoices() {
    const settings = window.loadGlobalSettings?.() || {};
    const fields = settings.app1?.fields || [];
    const specials = settings.app1?.specialActivities || [];
    
    const choices = [];
    
    // Generic types
    choices.push({ group: 'Types', items: [
        { value: 'activity', label: 'Activity (any)' },
        { value: 'sports', label: 'Sports (any sport)' },
        { value: 'special', label: 'Special (any special)' },
    ]});
    
    // Fixed events
    choices.push({ group: 'Fixed Events', items: [
        { value: 'lunch', label: 'Lunch' },
        { value: 'snacks', label: 'Snacks' },
        { value: 'swim', label: 'Swim' },
        { value: 'dismissal', label: 'Dismissal' },
    ]});
    
    // Specific fields/sports
    const fieldItems = [];
    fields.forEach(f => {
        if (!f.name) return;
        (f.activities || []).forEach(sport => {
            fieldItems.push({ value: 'specific:' + sport, label: sport + ' (' + f.name + ')' });
        });
    });
    if (fieldItems.length) choices.push({ group: 'Sports', items: fieldItems });
    
    // Specific specials
    const specItems = specials.map(s => ({ value: 'specific:' + s.name, label: s.name }));
    if (specItems.length) choices.push({ group: 'Specials', items: specItems });
    
    // Custom
    choices.push({ group: 'Other', items: [
        { value: 'custom', label: '+ Custom (type a name)' }
    ]});
    
    return choices;
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).substr(2, 4); }

// =================================================================
// MODAL — Smart follow-up questions
// =================================================================
function showAddModal(editItem) {
    return new Promise(resolve => {
        const existing = document.getElementById('ab-modal-overlay');
        if (existing) existing.remove();

        const choices = getActivityChoices();
        const isEdit = !!editItem;

        // Build grouped select options
        let optionsHtml = '<option value="">— Pick one —</option>';
        choices.forEach(group => {
            optionsHtml += `<optgroup label="${group.group}">`;
            group.items.forEach(item => {
                const sel = isEdit && editItem._choiceValue === item.value ? ' selected' : '';
                optionsHtml += `<option value="${item.value}"${sel}>${item.label}</option>`;
            });
            optionsHtml += '</optgroup>';
        });

        const overlay = document.createElement('div');
        overlay.id = 'ab-modal-overlay';
        overlay.className = 'ab-modal-overlay';
        overlay.innerHTML = `
            <div class="ab-modal">
                <div class="ab-modal-header">
                    <h3>${isEdit ? 'Edit Item' : 'Add Requirement'}</h3>
                    <button class="ab-modal-close">&times;</button>
                </div>
                <div class="ab-modal-body">
                    <div class="ab-modal-field">
                        <label>What needs to happen?</label>
                        <select id="ab-m-what" class="ab-modal-input">
                            ${optionsHtml}
                        </select>
                    </div>
                    <div id="ab-m-custom-row" class="ab-modal-field" style="display:none;">
                        <label>Custom name</label>
                        <input type="text" id="ab-m-custom-name" class="ab-modal-input" placeholder="e.g., Art Show, Color War" value="${isEdit && editItem.type === 'custom' ? editItem.name : ''}">
                    </div>
                    <div class="ab-modal-row">
                        <div class="ab-modal-field" style="flex:1;">
                            <label>Min duration</label>
                            <div class="ab-modal-dur-row">
                                <input type="number" id="ab-m-min-dur" class="ab-modal-input ab-modal-input-sm" value="${isEdit ? editItem.minDuration : '30'}" min="5" max="300" step="5">
                                <span class="ab-modal-unit">min</span>
                            </div>
                        </div>
                        <div class="ab-modal-field" style="flex:1;">
                            <label>Max duration</label>
                            <div class="ab-modal-dur-row">
                                <input type="number" id="ab-m-max-dur" class="ab-modal-input ab-modal-input-sm" value="${isEdit ? editItem.maxDuration : '50'}" min="5" max="300" step="5">
                                <span class="ab-modal-unit">min</span>
                            </div>
                        </div>
                    </div>
                    <div id="ab-m-time-section">
                        <div class="ab-modal-field">
                            <label>Time window <span style="font-weight:400;color:#94a3b8;">(leave blank for anytime)</span></label>
                            <div class="ab-modal-row">
                                <input type="text" id="ab-m-win-start" class="ab-modal-input" placeholder="earliest, e.g. 1:00pm" value="${isEdit && editItem.windowStart ? editItem.windowStart : ''}">
                                <span style="color:#94a3b8;">→</span>
                                <input type="text" id="ab-m-win-end" class="ab-modal-input" placeholder="latest end, e.g. 2:00pm" value="${isEdit && editItem.windowEnd ? editItem.windowEnd : ''}">
                            </div>
                        </div>
                        <div class="ab-modal-field" id="ab-m-fixed-row">
                            <label class="ab-modal-checkbox-label">
                                <input type="checkbox" id="ab-m-fixed" ${isEdit && editItem.fixed ? 'checked' : ''}>
                                <span>Exact time (fixed — like a visiting program)</span>
                            </label>
                        </div>
                    </div>
                </div>
                <div class="ab-modal-footer">
                    <button class="ab-btn ab-btn-ghost ab-modal-cancel">Cancel</button>
                    <button class="ab-btn ab-btn-primary ab-modal-confirm">${isEdit ? 'Update' : 'Add'}</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        // Show/hide custom name and time section based on selection
        const whatSel = overlay.querySelector('#ab-m-what');
        const customRow = overlay.querySelector('#ab-m-custom-row');
        const fixedRow = overlay.querySelector('#ab-m-fixed-row');

        function updateVisibility() {
            const val = whatSel.value;
            customRow.style.display = val === 'custom' ? 'block' : 'none';
            // Fixed events like lunch/snack/dismissal auto-set smart defaults
            if (['lunch', 'snacks', 'dismissal', 'swim'].includes(val)) {
                updateDefaultsForType(val, overlay);
            }
        }
        whatSel.onchange = updateVisibility;
        updateVisibility();

        // Event handlers
        const close = (val) => { overlay.remove(); resolve(val); };
        overlay.querySelector('.ab-modal-close').onclick = () => close(null);
        overlay.querySelector('.ab-modal-cancel').onclick = () => close(null);
        overlay.onclick = (e) => { if (e.target === overlay) close(null); };
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') close(null);
            if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
                overlay.querySelector('.ab-modal-confirm').click();
            }
        });

        overlay.querySelector('.ab-modal-confirm').onclick = () => {
            const what = whatSel.value;
            if (!what) return;

            let name, type;
            if (what === 'custom') {
                name = overlay.querySelector('#ab-m-custom-name').value.trim();
                type = 'custom';
                if (!name) return; // require a name
            } else if (what.startsWith('specific:')) {
                name = what.replace('specific:', '');
                type = 'custom'; // specific activities are treated as custom/pinned
            } else {
                name = whatSel.options[whatSel.selectedIndex].text;
                type = what;
            }

            const item = {
                id: isEdit ? editItem.id : uid(),
                name: name,
                type: type,
                _choiceValue: what,
                minDuration: parseInt(overlay.querySelector('#ab-m-min-dur').value) || 20,
                maxDuration: parseInt(overlay.querySelector('#ab-m-max-dur').value) || 50,
                windowStart: overlay.querySelector('#ab-m-win-start').value.trim() || null,
                windowEnd: overlay.querySelector('#ab-m-win-end').value.trim() || null,
                fixed: overlay.querySelector('#ab-m-fixed').checked,
            };

            // Ensure maxDuration >= minDuration
            if (item.maxDuration < item.minDuration) item.maxDuration = item.minDuration;

            close(item);
        };

        // Focus the dropdown
        setTimeout(() => whatSel.focus(), 50);
    });
}

function updateDefaultsForType(type, overlay) {
    const minInput = overlay.querySelector('#ab-m-min-dur');
    const maxInput = overlay.querySelector('#ab-m-max-dur');
    const winStart = overlay.querySelector('#ab-m-win-start');
    const winEnd = overlay.querySelector('#ab-m-win-end');
    const fixedCb = overlay.querySelector('#ab-m-fixed');

    // Only set defaults if fields are at their default/empty values
    const defaults = {
        lunch:     { min: 20, max: 20, ws: '11:30am', we: '1:30pm', fixed: false },
        snacks:    { min: 10, max: 10, ws: '2:30pm',  we: '3:30pm', fixed: false },
        dismissal: { min: 20, max: 20, ws: '',        we: '',       fixed: false },
        swim:      { min: 50, max: 60, ws: '',        we: '',       fixed: false },
    };

    const d = defaults[type];
    if (!d) return;

    // Only override if the user hasn't customized
    if (minInput.value === '30' || minInput.value === '50') minInput.value = d.min;
    if (maxInput.value === '50' || maxInput.value === '30') maxInput.value = d.max;
    if (!winStart.value && d.ws) winStart.value = d.ws;
    if (!winEnd.value && d.we) winEnd.value = d.we;
}

// =================================================================
// ITEM TYPE DISPLAY
// =================================================================
const TYPE_COLORS = {
    activity:'#93c5fd', sports:'#86efac', special:'#c4b5fd',
    league:'#fca5a5', specialty_league:'#fda4af', swim:'#67e8f9',
    lunch:'#fde68a', snack:'#fde68a', snacks:'#fde68a',
    dismissal:'#fca5a5', custom:'#d8b4fe'
};

function itemColor(item) {
    return TYPE_COLORS[item.type] || '#e2e8f0';
}

function itemTimeLabel(item) {
    if (item.fixed && item.windowStart && item.windowEnd) {
        return `${item.windowStart} – ${item.windowEnd} (fixed)`;
    }
    if (item.windowStart && item.windowEnd) {
        return `between ${item.windowStart} – ${item.windowEnd}`;
    }
    return 'anytime';
}

function itemDurLabel(item) {
    if (item.minDuration === item.maxDuration) return item.minDuration + 'min';
    return item.minDuration + '–' + item.maxDuration + 'min';
}

// =================================================================
// RENDER THE LIST
// =================================================================
function renderPanel() {
    const paletteEl = document.getElementById('scheduler-palette');
    if (!paletteEl) return;

    const divisions = getDivisions();
    const divNames = Object.keys(divisions);

    const itemsHtml = _items.length === 0
        ? '<div class="ab-empty">No requirements yet.<br>Click <b>+ Add</b> to describe what needs to happen today.</div>'
        : _items.map((item, idx) => `
            <div class="ab-item" data-idx="${idx}">
                <div class="ab-item-color" style="background:${itemColor(item)}"></div>
                <div class="ab-item-body">
                    <div class="ab-item-name">${item.name}</div>
                    <div class="ab-item-meta">
                        <span class="ab-item-dur">${itemDurLabel(item)}</span>
                        <span class="ab-item-when">${itemTimeLabel(item)}</span>
                    </div>
                </div>
                <div class="ab-item-actions">
                    <button class="ab-item-edit" data-idx="${idx}" title="Edit">✏️</button>
                    <button class="ab-item-dup" data-idx="${idx}" title="Duplicate">📋</button>
                    <button class="ab-item-del" data-idx="${idx}" title="Remove">&times;</button>
                </div>
            </div>
        `).join('');

    paletteEl.innerHTML = `
        <div class="ab-panel">
            <div class="ab-list">${itemsHtml}</div>
            
            <button id="ab-add-btn" class="ab-btn ab-btn-primary" style="width:100%;">
                + Add Requirement
            </button>
            
            ${_items.length > 0 ? `
                <div class="ab-summary">
                    <span>${_items.length} item${_items.length > 1 ? 's' : ''}</span>
                    <span>${totalDurLabel()} needed</span>
                </div>
                
                <div class="ab-build-group">
                    <button id="ab-build-btn" class="ab-btn ab-btn-success ab-btn-lg">
                        ⚡ Build Day
                    </button>
                    <button id="ab-build-fill-btn" class="ab-btn ab-btn-primary" style="width:100%;padding:7px;font-size:11px;">
                        ⚡ Build + Fill Schedule
                    </button>
                </div>
                
                <div id="ab-result-area"></div>
                
                <button id="ab-clear-btn" class="ab-btn ab-btn-ghost" style="width:100%;font-size:10px;margin-top:4px;">
                    Clear All
                </button>
            ` : ''}
        </div>
    `;

    wireListEvents();
}

function totalDurLabel() {
    let min = 0, max = 0;
    _items.forEach(i => { min += i.minDuration || 20; max += i.maxDuration || i.minDuration || 50; });
    if (min === max) return min + 'min';
    return min + '–' + max + 'min';
}

// =================================================================
// WIRE LIST EVENTS
// =================================================================
function wireListEvents() {
    // Add button
    document.getElementById('ab-add-btn')?.addEventListener('click', async () => {
        const item = await showAddModal();
        if (item) {
            _items.push(item);
            save();
            renderPanel();
        }
    });

    // Edit buttons
    document.querySelectorAll('.ab-item-edit').forEach(btn => {
        btn.onclick = async () => {
            const idx = parseInt(btn.dataset.idx);
            const updated = await showAddModal(_items[idx]);
            if (updated) {
                _items[idx] = updated;
                save();
                renderPanel();
            }
        };
    });

    // Duplicate buttons
    document.querySelectorAll('.ab-item-dup').forEach(btn => {
        btn.onclick = () => {
            const idx = parseInt(btn.dataset.idx);
            const copy = { ..._items[idx], id: uid() };
            _items.splice(idx + 1, 0, copy);
            save();
            renderPanel();
        };
    });

    // Delete buttons
    document.querySelectorAll('.ab-item-del').forEach(btn => {
        btn.onclick = () => {
            _items.splice(parseInt(btn.dataset.idx), 1);
            save();
            renderPanel();
        };
    });

    // Build buttons
    document.getElementById('ab-build-btn')?.addEventListener('click', () => executeBuild(false));
    document.getElementById('ab-build-fill-btn')?.addEventListener('click', () => executeBuild(true));

    // Clear
    document.getElementById('ab-clear-btn')?.addEventListener('click', () => {
        if (confirm('Clear all requirements?')) {
            _items = [];
            save();
            renderPanel();
        }
    });
}

// =================================================================
// EXECUTE BUILD
// =================================================================
function executeBuild(alsoOptimize) {
    const Engine = window.AutoBuildEngine;
    const MSI = window.MasterSchedulerInternal;
    if (!Engine || !MSI) {
        showResult('error', 'Engine or MasterScheduler not loaded.');
        return;
    }

    const divisions = getDivisions();
    const divNames = Object.keys(divisions);
    if (divNames.length === 0) {
        showResult('error', 'No divisions configured.');
        return;
    }
    if (_items.length === 0) {
        showResult('error', 'Add at least one requirement.');
        return;
    }

    showResult('progress', '');

    setTimeout(() => {
        const skeleton = [];
        const allWarnings = [];

        divNames.forEach(divName => {
            const divData = divisions[divName] || {};
            const dayStart = Engine.parseTime(divData.startTime || '9:00am');
            const dayEnd = Engine.parseTime(divData.endTime || '4:30pm');

            // Validate
            const errors = Engine.validate(_items, dayStart, dayEnd);
            if (errors.length) allWarnings.push(...errors.map(e => `${divName}: ${e}`));

            // Solve
            const result = Engine.solve(_items, dayStart, dayEnd);
            if (result.warnings.length) {
                allWarnings.push(...result.warnings.map(w => `${divName}: ${w}`));
            }

            // Convert to skeleton blocks
            result.placements.forEach(p => {
                skeleton.push({
                    id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 6),
                    type: p.skeletonType === 'pinned' ? 'pinned' : (p.skeletonType || 'slot'),
                    event: p.skeletonEvent,
                    division: divName,
                    startTime: p.startTime,
                    endTime: p.endTime,
                });
            });
        });

        // Apply to master scheduler
        MSI.setSkeleton(skeleton);
        MSI.markUnsavedChanges();
        MSI.saveDraftToLocalStorage();
        MSI.renderGrid();

        if (allWarnings.length > 0) {
            showResult('warning',
                `Built with ${allWarnings.length} warning(s):\n` +
                allWarnings.slice(0, 6).map(w => '• ' + w).join('\n') +
                (allWarnings.length > 6 ? `\n...+${allWarnings.length - 6} more` : ''));
        } else {
            showResult('success', `✓ ${skeleton.length} blocks across ${Object.keys(divisions).length} division(s)`);
        }

        if (alsoOptimize) {
            setTimeout(() => {
                window.saveCurrentDailyData?.('manualSkeleton', skeleton);
                if (typeof window.runSkeletonOptimizer === 'function') {
                    window.runSkeletonOptimizer(skeleton);
                    showResult('success', '⚡ Optimizer running...');
                }
            }, 300);
        }
    }, 50);
}

function showResult(type, msg) {
    const area = document.getElementById('ab-result-area');
    if (!area) return;
    if (type === 'progress') {
        area.innerHTML = '<div class="ab-progress"><div class="ab-progress-bar"></div></div>';
        return;
    }
    const cls = { success:'ab-result-success', warning:'ab-result-warning', error:'ab-result-error' }[type] || '';
    area.innerHTML = `<div class="ab-result-msg ${cls}">${(msg || '').replace(/\n/g, '<br>')}</div>`;
}

// =================================================================
// MODE TOGGLE — hooks into master_schedule_builder.js
// =================================================================
function injectToggle() {
    const header = document.querySelector('.ms-sidebar-header');
    if (!header || header.querySelector('#ab-mode-toggle')) return;

    header.style.position = 'relative';
    const btn = document.createElement('button');
    btn.id = 'ab-mode-toggle';
    btn.className = 'ms-btn ms-btn-ghost';
    btn.style.cssText = 'padding:4px 8px;font-size:10px;min-height:unset;position:absolute;right:12px;top:50%;transform:translateY(-50%);';
    btn.textContent = '⚡ Auto';
    btn.onclick = toggle;
    header.appendChild(btn);
}

function toggle() {
    _active = !_active;
    const btn = document.getElementById('ab-mode-toggle');
    const header = document.querySelector('.ms-sidebar-header');
    const h3 = header?.querySelector('h3');

    if (btn) {
        btn.textContent = _active ? '✋ Manual' : '⚡ Auto';
        btn.className = _active ? 'ms-btn ms-btn-primary' : 'ms-btn ms-btn-ghost';
        btn.style.cssText = 'padding:4px 8px;font-size:10px;min-height:unset;position:absolute;right:12px;top:50%;transform:translateY(-50%);';
    }
    if (h3) h3.textContent = _active ? 'Auto Build' : 'Tile Types';

    if (_active) {
        renderPanel();
    } else {
        // Restore manual palette
        if (window.MasterSchedulerInternal?.renderPalette) {
            window.MasterSchedulerInternal.renderPalette();
        }
    }
}

// =================================================================
// INIT — watch for MS tab to appear, then inject toggle
// =================================================================
function init() {
    load();

    // Hook into initMasterScheduler
    const orig = window.initMasterScheduler;
    if (orig && !orig._abHooked) {
        window.initMasterScheduler = function() {
            orig.apply(this, arguments);
            setTimeout(injectToggle, 50);
        };
        window.initMasterScheduler._abHooked = true;
    }

    // If already initialized, inject now
    if (document.querySelector('.ms-sidebar-header')) {
        injectToggle();
    }

    // MutationObserver as fallback
    const observer = new MutationObserver(() => {
        if (document.querySelector('.ms-sidebar-header') && !document.querySelector('#ab-mode-toggle')) {
            injectToggle();
            if (_active) renderPanel();
        }
    });
    const target = document.getElementById('master-scheduler-content');
    if (target) observer.observe(target, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    setTimeout(init, 200);
}

// Public API
window.AutoBuildUI = { toggle, renderPanel, getItems: () => _items, isActive: () => _active };
})();
