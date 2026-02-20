// =================================================================
// auto_schedule_planner.js — "What's Happening Today?" UI
// v1.0
// =================================================================
// Dead simple UI. The user tells the program what's happening today
// and hits one button. The program does everything else.
//
// Flow:
// 1. Open day → list auto-populates from recurring + always items
// 2. User scans: "yep, looks right" or tweaks
// 3. Hit Generate → solver builds skeleton → optimizer fills it → done
//
// DEPENDS ON: auto_schedule_solver.js, master_schedule_builder.js
// LOAD ORDER: After both
// =================================================================
(function() {
'use strict';

// ── State ──
let _active = false;
let _items = [];
const STORAGE_KEY = 'campistry_autosch';

function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_items)); } catch(e) {} }
function load() { try { const r = localStorage.getItem(STORAGE_KEY); if (r) _items = JSON.parse(r); } catch(e) {} }
function uid() { return Date.now().toString(36) + Math.random().toString(36).substr(2, 4); }

// ── Helpers ──
function getDivisions() {
    return window.divisions || window.loadGlobalSettings?.()?.app1?.divisions || {};
}

function getCurrentDay() {
    const d = window.currentScheduleDate || '';
    if (!d) return '';
    const [Y, M, D] = d.split('-').map(Number);
    if (!Y) return '';
    return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date(Y, M-1, D).getDay()] || '';
}

// ── Activity choices for dropdown ──
function getChoices() {
    const settings = window.loadGlobalSettings?.() || {};
    const app1 = settings.app1 || {};
    const groups = [];

    groups.push({ group: 'Slots (optimizer picks)', items: [
        { value: 'activity_slot', label: 'Activity (any)', kind: 'activity_slot' },
        { value: 'sport_slot', label: 'Sport', kind: 'sport_slot' },
        { value: 'special_slot', label: 'Special', kind: 'special_slot' },
    ]});

    groups.push({ group: 'Fixed Events', items: [
        { value: 'lunch', label: 'Lunch', kind: 'fixed_event', dur: 20, ws: '11:30am', we: '1:30pm' },
        { value: 'snacks', label: 'Snacks', kind: 'fixed_event', dur: 10, ws: '2:30pm', we: '3:30pm' },
        { value: 'swim', label: 'Swim', kind: 'specific', dur: 50 },
        { value: 'dismissal', label: 'Dismissal', kind: 'fixed_event', dur: 20 },
    ]});

    const specials = (app1.specialActivities || []).filter(s => s.available);
    if (specials.length) {
        groups.push({ group: 'Specials', items: specials.map(s => ({
            value: 'spec:' + s.name, label: s.name, kind: 'specific',
            dur: s.defaultDuration || null
        }))});
    }

    const sportSet = new Set();
    (app1.fields || []).forEach(f => {
        if (!f.available) return;
        (f.activities || []).forEach(sport => {
            if (sportSet.has(sport)) return;
            sportSet.add(sport);
            const meta = (app1.sportMetaData || {})[sport];
            groups.push // handled below
        });
    });
    const sportItems = [];
    (app1.fields || []).forEach(f => {
        if (!f.available) return;
        (f.activities || []).forEach(sport => {
            if (sportItems.some(s => s.label === sport)) return;
            const meta = (app1.sportMetaData || {})[sport];
            sportItems.push({ value: 'sport:' + sport, label: sport, kind: 'specific', dur: meta?.defaultDuration || null });
        });
    });
    if (sportItems.length) groups.push({ group: 'Sports', items: sportItems });

    groups.push({ group: 'Other', items: [
        { value: 'custom', label: '+ Custom…', kind: 'specific' }
    ]});

    return groups;
}

// ── Colors ──
const COLORS = {
    activity_slot:'#93c5fd', sport_slot:'#86efac', special_slot:'#c4b5fd',
    specific:'#d8b4fe', fixed_event:'#fde68a', swim:'#67e8f9',
    lunch:'#fde68a', snacks:'#fde68a', dismissal:'#fed7aa'
};

// =================================================================
// ADD MODAL
// =================================================================
function showAddModal(editItem) {
    return new Promise(resolve => {
        const old = document.getElementById('as-modal-overlay');
        if (old) old.remove();

        const groups = getChoices();
        const isEdit = !!editItem;

        let optsHtml = '<option value="">— Pick —</option>';
        groups.forEach(g => {
            optsHtml += `<optgroup label="${g.group}">`;
            g.items.forEach(i => {
                const sel = isEdit && editItem._val === i.value ? ' selected' : '';
                optsHtml += `<option value="${i.value}" data-kind="${i.kind}" data-dur="${i.dur||''}" data-ws="${i.ws||''}" data-we="${i.we||''}"${sel}>${i.label}</option>`;
            });
            optsHtml += '</optgroup>';
        });

        const ov = document.createElement('div');
        ov.id = 'as-modal-overlay';
        ov.className = 'as-modal-overlay';
        ov.innerHTML = `
            <div class="as-modal">
                <div class="as-modal-head"><h3>${isEdit ? 'Edit' : 'Add to Today'}</h3><button class="as-modal-x">&times;</button></div>
                <div class="as-modal-body">
                    <div class="as-f"><label>What?</label><select id="as-m-what" class="as-input">${optsHtml}</select></div>
                    <div id="as-m-custom-f" class="as-f" style="display:none"><label>Name</label><input type="text" id="as-m-name" class="as-input" placeholder="e.g., Bubble Lady, Color War" value="${isEdit && editItem.kind==='specific' ? editItem.name : ''}"></div>
                    <div class="as-f-row">
                        <div class="as-f" style="flex:1"><label>How many?</label><input type="number" id="as-m-count" class="as-input as-input-sm" value="${isEdit ? editItem.count||1 : 1}" min="1" max="20"></div>
                        <div class="as-f" style="flex:1"><label>Duration</label>
                            <div class="as-dur"><input type="number" id="as-m-dur" class="as-input as-input-sm" value="${isEdit ? editItem.duration||'' : ''}" min="5" max="300" step="5" placeholder="auto"><span class="as-unit">min</span></div>
                        </div>
                    </div>
                    <div class="as-f"><label>Time window <span class="as-hint">(blank = anytime)</span></label>
                        <div class="as-f-row">
                            <input type="text" id="as-m-ws" class="as-input" placeholder="earliest, e.g. 1:00pm" value="${isEdit&&editItem.windowStart||''}">
                            <span class="as-arrow">→</span>
                            <input type="text" id="as-m-we" class="as-input" placeholder="latest end" value="${isEdit&&editItem.windowEnd||''}">
                        </div>
                    </div>
                    <div class="as-f"><label class="as-check"><input type="checkbox" id="as-m-fixed" ${isEdit&&editItem.fixed?'checked':''}><span>Exact time (they're coming at this time)</span></label></div>
                </div>
                <div class="as-modal-foot">
                    <button class="as-btn as-btn-ghost" id="as-m-cancel">Cancel</button>
                    <button class="as-btn as-btn-primary" id="as-m-ok">${isEdit ? 'Update' : 'Add'}</button>
                </div>
            </div>`;
        document.body.appendChild(ov);

        const whatSel = ov.querySelector('#as-m-what');
        const customF = ov.querySelector('#as-m-custom-f');
        const durIn = ov.querySelector('#as-m-dur');
        const wsIn = ov.querySelector('#as-m-ws');
        const weIn = ov.querySelector('#as-m-we');
        const countIn = ov.querySelector('#as-m-count');

        function onChange() {
            const v = whatSel.value;
            customF.style.display = v === 'custom' ? 'block' : 'none';
            if (isEdit) return;
            const opt = whatSel.selectedOptions[0];
            if (opt?.dataset.dur) durIn.value = opt.dataset.dur;
            if (opt?.dataset.ws) wsIn.value = opt.dataset.ws;
            if (opt?.dataset.we) weIn.value = opt.dataset.we;
            // Slots default to count-friendly
            if (['activity_slot','sport_slot','special_slot'].includes(v)) {
                countIn.value = v === 'special_slot' ? 3 : 1;
            } else {
                countIn.value = 1;
            }
            // Pull duration from settings for specific items
            if (v?.startsWith('spec:') || v?.startsWith('sport:')) {
                const name = v.split(':')[1];
                const d = window.AutoScheduleSolver?.getActivityDuration?.(name);
                if (d) durIn.value = d;
            }
        }
        whatSel.onchange = onChange;
        onChange();

        const close = v => { ov.remove(); resolve(v); };
        ov.querySelector('.as-modal-x').onclick = () => close(null);
        ov.querySelector('#as-m-cancel').onclick = () => close(null);
        ov.onclick = e => { if (e.target === ov) close(null); };
        ov.addEventListener('keydown', e => {
            if (e.key === 'Escape') close(null);
            if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') ov.querySelector('#as-m-ok').click();
        });

        ov.querySelector('#as-m-ok').onclick = () => {
            const v = whatSel.value;
            if (!v) return;
            let name, kind;
            if (v === 'custom') {
                name = ov.querySelector('#as-m-name').value.trim();
                if (!name) return;
                kind = 'specific';
            } else if (v.startsWith('spec:') || v.startsWith('sport:')) {
                name = v.split(':')[1];
                kind = 'specific';
            } else if (['lunch','snacks','dismissal'].includes(v)) {
                name = whatSel.selectedOptions[0]?.text || v;
                kind = 'fixed_event';
            } else if (v === 'swim') {
                name = 'Swim'; kind = 'specific';
            } else {
                name = whatSel.selectedOptions[0]?.text || v;
                kind = v; // sport_slot, special_slot, activity_slot
            }

            close({
                id: isEdit ? editItem.id : uid(),
                name, kind,
                _val: v,
                count: parseInt(countIn.value) || 1,
                duration: parseInt(durIn.value) || null,
                windowStart: wsIn.value.trim() || null,
                windowEnd: weIn.value.trim() || null,
                fixed: ov.querySelector('#as-m-fixed').checked,
            });
        };
        setTimeout(() => whatSel.focus(), 50);
    });
}

// =================================================================
// RENDER
// =================================================================
function renderPanel() {
    const el = document.getElementById('scheduler-palette');
    if (!el) return;

    const day = getCurrentDay();
    const Solver = window.AutoScheduleSolver;

    // Display helpers
    function kindLabel(item) {
        const map = { activity_slot:'slot', sport_slot:'sport slot', special_slot:'special slot', specific:'specific', fixed_event:'fixed' };
        return map[item.kind] || item.kind;
    }
    function kindClass(item) {
        if (item.kind === 'specific') return 'as-tag-specific';
        if (item.kind === 'fixed_event') return 'as-tag-fixed';
        return 'as-tag-slot';
    }
    function timeLabel(item) {
        if (item.fixed && item.windowStart && item.windowEnd) return `${item.windowStart}–${item.windowEnd}`;
        if (item.windowStart && item.windowEnd) return `${item.windowStart}–${item.windowEnd}`;
        return '';
    }
    function durLabel(item) {
        if (item.duration) return item.duration + 'min';
        return '';
    }

    const itemsHtml = _items.length === 0
        ? `<div class="as-empty">${day ? `What's happening <b>${day}</b>?` : "What's happening today?"}<br>Add your activities or hit <b>🔄 Auto-fill</b>.</div>`
        : _items.map((item, i) => {
            const countLabel = item.count > 1 ? `<span class="as-count">&times;${item.count}</span>` : '';
            const dur = durLabel(item);
            const time = timeLabel(item);
            const source = item.source === 'recurring' ? '<span class="as-tag as-tag-rec">recurring</span>' : '';
            const cancelled = item.cancelled ? ' as-item-cancelled' : '';

            return `
                <div class="as-item${cancelled}" data-idx="${i}">
                    <div class="as-item-left" style="border-color:${COLORS[item.kind] || COLORS.specific || '#e2e8f0'}">
                        <div class="as-item-name">${item.name} ${countLabel} <span class="as-tag ${kindClass(item)}">${kindLabel(item)}</span> ${source}</div>
                        <div class="as-item-meta">
                            ${dur ? `<span>${dur}</span>` : ''}
                            ${time ? `<span class="as-item-time">${time}${item.fixed ? ' ✦' : ''}</span>` : '<span class="as-item-time">anytime</span>'}
                        </div>
                    </div>
                    <div class="as-item-btns">
                        ${item.cancelled
                            ? `<button class="as-act" data-action="restore" data-idx="${i}" title="Restore">↩️</button>`
                            : `<button class="as-act" data-action="cancel" data-idx="${i}" title="Cancel for today">✕</button>`
                        }
                        <button class="as-act" data-action="edit" data-idx="${i}" title="Edit">✏️</button>
                        <button class="as-act" data-action="del" data-idx="${i}" title="Remove">&times;</button>
                    </div>
                </div>`;
        }).join('');

    // Summary
    const activeItems = _items.filter(i => !i.cancelled);
    let totalDur = 0;
    activeItems.forEach(i => { totalDur += (i.duration || 50) * (i.count || 1); });

    el.innerHTML = `
        <div class="as-panel">
            ${day ? `<div class="as-day">📅 ${day}</div>` : ''}
            <div class="as-list">${itemsHtml}</div>
            <div class="as-btn-row">
                <button id="as-add" class="as-btn as-btn-primary" style="flex:1">+ Add</button>
                <button id="as-autofill" class="as-btn as-btn-ghost" title="Pull recurring activities for today">🔄 Auto-fill</button>
            </div>
            ${activeItems.length > 0 ? `
                <div class="as-summary">
                    <span>${activeItems.length} active${_items.some(i=>i.cancelled) ? `, ${_items.filter(i=>i.cancelled).length} cancelled` : ''}</span>
                    <span>~${totalDur}min</span>
                </div>
                <button id="as-generate" class="as-btn as-btn-success as-btn-lg">⚡ Generate Schedule</button>
                <div id="as-result"></div>
                <button id="as-clear" class="as-btn as-btn-ghost" style="width:100%;font-size:10px;margin-top:2px">Clear All</button>
            ` : ''}
        </div>`;

    wireEvents();
}

// =================================================================
// WIRE EVENTS
// =================================================================
function wireEvents() {
    document.getElementById('as-add')?.addEventListener('click', async () => {
        const item = await showAddModal();
        if (item) { _items.push(item); save(); renderPanel(); }
    });

    document.getElementById('as-autofill')?.addEventListener('click', () => {
        const day = getCurrentDay();
        if (!day) { alert('Select a date first.'); return; }
        const Solver = window.AutoScheduleSolver;
        if (!Solver) return;

        const recurring = Solver.getRecurringForDay(day);
        let added = 0;

        // Add recurring items not already present
        recurring.forEach(r => {
            if (!_items.some(i => i.name === r.name && !i.cancelled)) {
                _items.push({ ...r, id: uid(), count: 1, _val: 'spec:' + r.name });
                added++;
            }
        });

        // Add default always-items if not present
        const defaults = [
            { name: 'Lunch', kind: 'fixed_event', duration: 20, windowStart: '11:30am', windowEnd: '1:30pm', _val: 'lunch' },
            { name: 'Snacks', kind: 'fixed_event', duration: 10, windowStart: '2:30pm', windowEnd: '3:30pm', _val: 'snacks' },
            { name: 'Dismissal', kind: 'fixed_event', duration: 20, _val: 'dismissal' },
        ];
        defaults.forEach(d => {
            if (!_items.some(i => i.name === d.name && !i.cancelled)) {
                _items.push({ ...d, id: uid(), count: 1 });
                added++;
            }
        });

        save(); renderPanel();
        showMsg(added > 0 ? 'success' : 'warning',
            added > 0 ? `Added ${added} item(s) for ${day}` : 'Everything already in list');
    });

    // Item action buttons
    document.querySelectorAll('.as-act').forEach(btn => {
        btn.onclick = async () => {
            const idx = parseInt(btn.dataset.idx);
            const action = btn.dataset.action;
            if (action === 'cancel') { _items[idx].cancelled = true; }
            else if (action === 'restore') { _items[idx].cancelled = false; }
            else if (action === 'del') { _items.splice(idx, 1); }
            else if (action === 'edit') {
                const updated = await showAddModal(_items[idx]);
                if (updated) _items[idx] = updated;
            }
            save(); renderPanel();
        };
    });

    // Generate
    document.getElementById('as-generate')?.addEventListener('click', () => {
        const Solver = window.AutoScheduleSolver;
        if (!Solver) { showMsg('error', 'Solver not loaded.'); return; }

        const activeItems = _items.filter(i => !i.cancelled);
        if (!activeItems.length) { showMsg('error', 'No active items.'); return; }

        showMsg('progress', '');

        setTimeout(() => {
            const result = Solver.generateAndRun(activeItems);

            if (!result.success) {
                showMsg('error', result.warnings.join('\n'));
                return;
            }

            if (result.warnings.length) {
                showMsg('warning',
                    `Schedule generated with ${result.warnings.length} note(s):\n` +
                    result.warnings.slice(0, 5).map(w => '• ' + w).join('\n'));
            } else {
                const divCount = Object.keys(getDivisions()).length;
                showMsg('success',
                    `✓ Schedule generated! ${result.skeleton.length} blocks across ${divCount} division(s).` +
                    (result.optimizerRan ? '\n⚡ Optimizer ran — check the Schedule tab.' : ''));
            }
        }, 100);
    });

    // Clear
    document.getElementById('as-clear')?.addEventListener('click', () => {
        if (confirm('Clear all items?')) { _items = []; save(); renderPanel(); }
    });
}

function showMsg(type, msg) {
    const el = document.getElementById('as-result');
    if (!el) return;
    if (type === 'progress') { el.innerHTML = '<div class="as-progress"><div class="as-progress-bar"></div></div>'; return; }
    const cls = { success:'as-msg-ok', warning:'as-msg-warn', error:'as-msg-err' }[type] || '';
    el.innerHTML = `<div class="as-msg ${cls}">${(msg||'').replace(/\n/g,'<br>')}</div>`;
}

// =================================================================
// MODE TOGGLE
// =================================================================
function injectToggle() {
    const header = document.querySelector('.ms-sidebar-header');
    if (!header || header.querySelector('#as-toggle')) return;
    header.style.position = 'relative';
    const btn = document.createElement('button');
    btn.id = 'as-toggle';
    btn.className = 'ms-btn ms-btn-ghost';
    btn.style.cssText = 'padding:4px 8px;font-size:10px;min-height:unset;position:absolute;right:12px;top:50%;transform:translateY(-50%);';
    btn.textContent = '⚡ Auto';
    btn.onclick = toggle;
    header.appendChild(btn);
}

function toggle() {
    _active = !_active;
    const btn = document.getElementById('as-toggle');
    const h3 = document.querySelector('.ms-sidebar-header h3');
    if (btn) {
        btn.textContent = _active ? '✋ Manual' : '⚡ Auto';
        btn.className = _active ? 'ms-btn ms-btn-primary' : 'ms-btn ms-btn-ghost';
        btn.style.cssText = 'padding:4px 8px;font-size:10px;min-height:unset;position:absolute;right:12px;top:50%;transform:translateY(-50%);';
    }
    if (h3) h3.textContent = _active ? "Today's Schedule" : 'Tile Types';
    if (_active) renderPanel();
    else if (window.MasterSchedulerInternal?.renderPalette) window.MasterSchedulerInternal.renderPalette();
}

// =================================================================
// INIT
// =================================================================
function init() {
    load();
    const orig = window.initMasterScheduler;
    if (orig && !orig._asHooked) {
        window.initMasterScheduler = function() {
            orig.apply(this, arguments);
            setTimeout(injectToggle, 50);
        };
        window.initMasterScheduler._asHooked = true;
    }
    if (document.querySelector('.ms-sidebar-header')) injectToggle();

    new MutationObserver(() => {
        if (document.querySelector('.ms-sidebar-header') && !document.querySelector('#as-toggle')) {
            injectToggle();
            if (_active) renderPanel();
        }
    }).observe(document.getElementById('master-scheduler-content') || document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else setTimeout(init, 200);

window.AutoSchedulePlanner = { toggle, renderPanel, getItems: () => _items, isActive: () => _active };
})();
