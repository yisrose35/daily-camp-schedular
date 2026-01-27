// =================================================================
// SCHEDULE BUILDER v8.0 — APPLE DESIGN LANGUAGE
// =================================================================
// Design Philosophy:
// - SF Pro typography, clean and legible
// - Generous whitespace, content breathes
// - Soft corners, subtle depth
// - Vibrancy and blur effects
// - Restrained color, purposeful accents
// - Micro-interactions that feel tactile
// =================================================================

(function() {
'use strict';

// =================================================================
// STATE
// =================================================================
let skeleton = [];
let template = null;
let container = null;
let clipboard = null;
let hoveredCol = null;
let _keyHandler = null;
let _visHandler = null;
let _focusHandler = null;

const STORAGE_KEY = 'scheduleBuilder_v8';
const PX_MIN = 1.4;
const SNAP = 5;

// Apple-inspired muted colors
const TYPES = {
    activity:         { name: 'Activity',    color: '#007AFF', desc: 'General activity slot' },
    sports:           { name: 'Sports',      color: '#34C759', desc: 'Sports period' },
    special:          { name: 'Special',     color: '#30B650', desc: 'Special activity' },
    smart:            { name: 'Smart',       color: '#5856D6', desc: 'Auto-balanced slot', dashed: true },
    split:            { name: 'Split',       color: '#FF9500', desc: 'Divided time block' },
    elective:         { name: 'Elective',    color: '#AF52DE', desc: 'Choice-based' },
    league:           { name: 'League',      color: '#5856D6', desc: 'League game' },
    specialty_league: { name: 'Specialty',   color: '#FFCC00', desc: 'Specialty league' },
    swim:             { name: 'Swim',        color: '#32ADE6', desc: 'Swimming' },
    lunch:            { name: 'Lunch',       color: '#FF3B30', desc: 'Lunch break' },
    snacks:           { name: 'Snacks',      color: '#FF9500', desc: 'Snack time' },
    dismissal:        { name: 'Dismissal',   color: '#FF2D55', desc: 'End of day' },
    custom:           { name: 'Custom',      color: '#8E8E93', desc: 'Custom event' }
};

// =================================================================
// UTILITIES
// =================================================================
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = s => { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; };

const toMin = s => {
    if (!s) return null;
    const t = s.toLowerCase().replace(/\s/g, '');
    const pm = t.includes('pm'), am = t.includes('am');
    let [h, m] = t.replace(/[ap]m/g, '').split(':').map(Number);
    if (isNaN(h)) return null;
    if (pm && h !== 12) h += 12;
    if (am && h === 12) h = 0;
    return h * 60 + (m || 0);
};

const toStr = m => {
    if (m == null) return '';
    let h = Math.floor(m / 60), mm = m % 60;
    const a = h >= 12 ? 'PM' : 'AM';
    return `${h % 12 || 12}:${String(mm).padStart(2, '0')} ${a}`;
};

const range = () => {
    const divs = window.divisions || {};
    let lo = null, hi = null;
    Object.values(divs).filter(d => d?.bunks?.length).forEach(d => {
        const s = toMin(d.startTime), e = toMin(d.endTime);
        if (s != null && (lo == null || s < lo)) lo = s;
        if (e != null && (hi == null || e > hi)) hi = e;
    });
    skeleton.forEach(ev => {
        const s = toMin(ev.startTime), e = toMin(ev.endTime);
        if (s != null && (lo == null || s < lo)) lo = s;
        if (e != null && (hi == null || e > hi)) hi = e;
    });
    return { lo: lo ?? 480, hi: hi ?? 1020 };
};

const getLocations = () => {
    const gs = window.loadGlobalSettings?.() || {};
    const locs = [];
    (gs.app1?.fields || []).forEach(f => f.available !== false && locs.push({ n: f.name, c: 'Field' }));
    Object.values(gs.locationZones || {}).forEach(z => {
        Object.keys(z.locations || {}).forEach(n => {
            if (!locs.find(l => l.n === n)) locs.push({ n, c: z.name || 'Zone' });
        });
    });
    return locs;
};

// =================================================================
// STORAGE
// =================================================================
const save = () => {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ skeleton, template }));
    } catch (e) {}
    syncUI();
};

const load = () => {
    try {
        const d = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        if (d.skeleton) { skeleton = d.skeleton; template = d.template || null; return true; }
    } catch (e) {}
    return false;
};

const clearStorage = () => localStorage.removeItem(STORAGE_KEY);

// =================================================================
// TEMPLATE OPERATIONS
// =================================================================
const loadTpl = name => {
    const all = window.getSavedSkeletons?.() || {};
    if (!all[name]) return;
    skeleton = JSON.parse(JSON.stringify(all[name]));
    template = name;
    clearStorage();
    draw();
    toast('Template loaded');
};

const saveTpl = (name, update) => {
    if (!name) return;
    window.saveSkeleton?.(name, skeleton);
    window.forceSyncToCloud?.();
    template = name;
    clearStorage();
    fillSelects();
    syncUI();
    toast(update ? 'Changes saved' : 'Template created');
};

const deleteTpl = name => {
    if (!name) return;
    window.deleteSkeleton?.(name);
    window.forceSyncToCloud?.();
    if (template === name) { template = null; skeleton = []; clearStorage(); draw(); }
    fillSelects();
    syncUI();
    toast('Template deleted');
};

const fillSelects = () => {
    const all = window.getSavedSkeletons?.() || {};
    const opts = Object.keys(all).sort().map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    const sel = document.getElementById('ap-tpl-select');
    const del = document.getElementById('ap-del-select');
    if (sel) sel.innerHTML = `<option value="">Select Template</option>${opts}`;
    if (del) del.innerHTML = `<option value="">Select to delete...</option>${opts}`;
};

// =================================================================
// TOAST
// =================================================================
const toast = msg => {
    let t = document.getElementById('ap-toast');
    if (!t) { t = document.createElement('div'); t.id = 'ap-toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2200);
};

// =================================================================
// UI SYNC
// =================================================================
const syncUI = () => {
    const badge = document.getElementById('ap-badge');
    const name = document.getElementById('ap-tpl-name');
    const upd = document.getElementById('ap-update');
    if (!badge) return;
    
    if (template) {
        badge.className = 'ap-badge ap-badge-saved';
        badge.textContent = 'Saved';
        name.textContent = template;
        if (upd) upd.style.display = '';
    } else if (skeleton.length) {
        badge.className = 'ap-badge ap-badge-draft';
        badge.textContent = 'Draft';
        name.textContent = 'Unsaved changes';
        if (upd) upd.style.display = 'none';
    } else {
        badge.className = 'ap-badge';
        badge.textContent = '';
        name.textContent = 'New Schedule';
        if (upd) upd.style.display = 'none';
    }
};

// =================================================================
// KEYBOARD SHORTCUTS
// =================================================================
const setupKeyboard = () => {
    _keyHandler = e => {
        const tab = document.getElementById('master-scheduler');
        if (!tab || !tab.classList.contains('active')) return;
        
        const grid = document.getElementById('ap-grid');
        const selected = grid?.querySelector('.ap-ev.selected');
        
        // Ctrl/Cmd + C - Copy
        if ((e.ctrlKey || e.metaKey) && e.key === 'c' && selected) {
            const ev = skeleton.find(x => x.id === selected.dataset.id);
            if (ev) {
                clipboard = { ...ev, id: null };
                toast('Copied');
            }
            e.preventDefault();
        }
        
        // Ctrl/Cmd + V - Paste
        if ((e.ctrlKey || e.metaKey) && e.key === 'v' && clipboard && hoveredCol) {
            const { lo } = range();
            const dur = toMin(clipboard.endTime) - toMin(clipboard.startTime);
            const start = lo;
            
            skeleton.push({
                ...clipboard,
                id: uid(),
                division: hoveredCol.dataset.d,
                startTime: toStr(start),
                endTime: toStr(start + dur)
            });
            save();
            draw();
            toast('Pasted');
            e.preventDefault();
        }
        
        // Delete/Backspace - Remove selected
        if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !e.target.matches('input, textarea, select')) {
            skeleton = skeleton.filter(x => x.id !== selected.dataset.id);
            save();
            draw();
            e.preventDefault();
        }
    };
    document.addEventListener('keydown', _keyHandler);
};

// =================================================================
// TAB VISIBILITY
// =================================================================
const setupVisibility = () => {
    _visHandler = () => {
        if (document.visibilityState === 'visible') {
            setTimeout(fillSelects, 200);
        }
    };
    document.addEventListener('visibilitychange', _visHandler);
    
    _focusHandler = () => setTimeout(fillSelects, 250);
    window.addEventListener('focus', _focusHandler);
};

// =================================================================
// MODAL
// =================================================================
const modal = (type, div, startM, existing) => {
    const T = TYPES[type];
    if (!T) return;
    const { lo } = range();
    let sM = existing ? toMin(existing.startTime) : (startM ?? lo);
    let eM = existing ? toMin(existing.endTime) : sM + 30;
    
    const locs = getLocations();
    
    let fields = '';
    if (type === 'custom') {
        fields = `<div class="ap-field"><label>Event Name</label><input id="mf-name" value="${esc(existing?.event || '')}" placeholder="Enter name..." autofocus></div>`;
    } else if (type === 'smart') {
        fields = `
            <div class="ap-field-row">
                <div class="ap-field"><label>Activity 1</label><input id="mf-a1" value="${esc(existing?.smartData?.activity1 || '')}"></div>
                <div class="ap-field"><label>Activity 2</label><input id="mf-a2" value="${esc(existing?.smartData?.activity2 || '')}"></div>
            </div>
            <div class="ap-field-row">
                <div class="ap-field"><label>Fallback For</label><select id="mf-ff"><option value="1">Activity 1</option><option value="2">Activity 2</option></select></div>
                <div class="ap-field"><label>Fallback Activity</label><input id="mf-fb" value="${esc(existing?.smartData?.fallbackActivity || '')}"></div>
            </div>
        `;
    } else if (type === 'split') {
        fields = `<div class="ap-field-row"><div class="ap-field"><label>First Half</label><input id="mf-s1" value="${esc(existing?.subEvents?.[0]?.activity || '')}"></div><div class="ap-field"><label>Second Half</label><input id="mf-s2" value="${esc(existing?.subEvents?.[1]?.activity || '')}"></div></div>`;
    } else if (type === 'elective') {
        const gs = window.loadGlobalSettings?.() || {};
        const acts = [...(gs.app1?.fields || []).filter(f => f.available !== false).map(f => f.name), ...(gs.app1?.specialActivities || []).filter(s => s.available !== false).map(s => s.name)];
        const sel = existing?.electiveActivities || [];
        fields = `<div class="ap-field"><label>Choose Activities</label><div class="ap-checks">${acts.map(a => `<label><input type="checkbox" name="el" value="${esc(a)}" ${sel.includes(a) ? 'checked' : ''}><span>${esc(a)}</span></label>`).join('')}</div></div>`;
    }
    
    let locHTML = '';
    if (type === 'custom' && locs.length) {
        const res = existing?.reservedFields || [];
        locHTML = `<div class="ap-field"><label>Reserve Locations</label><div class="ap-checks">${locs.map(l => `<label><input type="checkbox" name="loc" value="${esc(l.n)}" ${res.includes(l.n) ? 'checked' : ''}><span>${esc(l.n)}</span><small>${esc(l.c)}</small></label>`).join('')}</div></div>`;
    }
    
    const el = document.createElement('div');
    el.id = 'ap-modal-wrap';
    el.innerHTML = `
<div class="ap-modal">
    <div class="ap-modal-bar" style="background: ${T.color}"></div>
    <header class="ap-modal-head">
        <div>
            <h2>${existing ? 'Edit' : 'New'} ${esc(T.name)}</h2>
            <p>${esc(T.desc)}</p>
        </div>
        <button class="ap-modal-close" id="mx">
            <svg width="12" height="12" viewBox="0 0 12 12"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
    </header>
    <main class="ap-modal-body">
        ${fields}
        <div class="ap-field">
            <label>Time</label>
            <div class="ap-time">
                <div class="ap-time-input">
                    <button type="button" data-a="s-">−</button>
                    <input id="mf-s" value="${toStr(sM)}">
                    <button type="button" data-a="s+">+</button>
                </div>
                <span class="ap-time-sep">to</span>
                <div class="ap-time-input">
                    <button type="button" data-a="e-">−</button>
                    <input id="mf-e" value="${toStr(eM)}">
                    <button type="button" data-a="e+">+</button>
                </div>
            </div>
            <div class="ap-presets">
                <button type="button" data-d="15">15 min</button>
                <button type="button" data-d="30">30 min</button>
                <button type="button" data-d="45">45 min</button>
                <button type="button" data-d="60">1 hour</button>
            </div>
        </div>
        ${locHTML}
    </main>
    <footer class="ap-modal-foot">
        <button class="ap-btn ap-btn-secondary" id="mc">Cancel</button>
        <button class="ap-btn ap-btn-primary" id="ms">${existing ? 'Save Changes' : 'Add to Schedule'}</button>
    </footer>
</div>`;
    document.body.appendChild(el);
    
    const $s = document.getElementById('mf-s'), $e = document.getElementById('mf-e');
    const sync = () => { $s.value = toStr(sM); $e.value = toStr(eM); };
    
    $s.onblur = () => { const v = toMin($s.value); if (v != null) { sM = v; if (sM >= eM) eM = sM + 30; } sync(); };
    $e.onblur = () => { const v = toMin($e.value); if (v != null && v > sM) eM = v; sync(); };
    
    el.querySelectorAll('.ap-time button').forEach(b => b.onclick = () => {
        const a = b.dataset.a;
        if (a === 's+') sM = Math.min(sM + 5, eM - 5);
        else if (a === 's-') sM = Math.max(sM - 5, 0);
        else if (a === 'e+') eM = Math.min(eM + 5, 1439);
        else if (a === 'e-') eM = Math.max(eM - 5, sM + 5);
        sync();
    });
    
    el.querySelectorAll('.ap-presets button').forEach(b => b.onclick = () => { eM = sM + +b.dataset.d; sync(); });
    
    const close = () => el.remove();
    document.getElementById('mx').onclick = close;
    document.getElementById('mc').onclick = close;
    el.onclick = e => e.target === el && close();
    
    document.getElementById('ms').onclick = () => {
        const ev = existing ? { ...existing } : { id: uid(), type, event: T.name, division: div, reservedFields: [] };
        ev.startTime = toStr(sM);
        ev.endTime = toStr(eM);
        
        if (type === 'custom') {
            const n = document.getElementById('mf-name')?.value.trim();
            if (!n) return alert('Please enter a name');
            ev.event = n;
            ev.reservedFields = [...el.querySelectorAll('input[name="loc"]:checked')].map(c => c.value);
        } else if (type === 'smart') {
            const a1 = document.getElementById('mf-a1')?.value.trim();
            const a2 = document.getElementById('mf-a2')?.value.trim();
            const fb = document.getElementById('mf-fb')?.value.trim();
            if (!a1 || !a2 || !fb) return alert('Please fill in all fields');
            ev.smartData = { activity1: a1, activity2: a2, fallbackFor: document.getElementById('mf-ff').value === '1' ? a1 : a2, fallbackActivity: fb };
        } else if (type === 'split') {
            const s1 = document.getElementById('mf-s1')?.value.trim();
            const s2 = document.getElementById('mf-s2')?.value.trim();
            if (!s1 || !s2) return alert('Please fill in both activities');
            const mid = sM + Math.floor((eM - sM) / 2);
            ev.subEvents = [{ activity: s1, startTime: toStr(sM), endTime: toStr(mid) }, { activity: s2, startTime: toStr(mid), endTime: toStr(eM) }];
        } else if (type === 'elective') {
            const acts = [...el.querySelectorAll('input[name="el"]:checked')].map(c => c.value);
            if (acts.length < 2) return alert('Please select at least 2 activities');
            ev.electiveActivities = acts;
        }
        
        if (existing) {
            const i = skeleton.findIndex(x => x.id === existing.id);
            if (i >= 0) skeleton[i] = ev;
        } else {
            skeleton.push(ev);
        }
        
        close();
        save();
        draw();
    };
    
    setTimeout(() => el.querySelector('input:not([type="checkbox"])')?.focus(), 50);
};

// =================================================================
// RENDER
// =================================================================
const render = () => {
    if (!container) return;
    container.innerHTML = `
<div class="ap">
    <header class="ap-header">
        <div class="ap-header-title">
            <h1>Schedule Builder</h1>
            <div class="ap-status">
                <span id="ap-badge" class="ap-badge"></span>
                <span id="ap-tpl-name" class="ap-tpl-name">New Schedule</span>
            </div>
        </div>
        <div class="ap-header-actions">
            <div class="ap-action-group">
                <select id="ap-tpl-select"></select>
                <button class="ap-btn ap-btn-secondary" id="ap-load">Load</button>
            </div>
            <div class="ap-divider"></div>
            <div class="ap-action-group">
                <input id="ap-save-name" placeholder="Template name...">
                <button class="ap-btn ap-btn-primary" id="ap-save">Save</button>
                <button class="ap-btn ap-btn-secondary" id="ap-update" style="display:none">Update</button>
            </div>
        </div>
    </header>
    
    <div class="ap-content">
        <aside class="ap-sidebar">
            <div class="ap-sidebar-header">
                <span>Blocks</span>
                <button class="ap-icon-btn" id="ap-clear" title="Clear schedule">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M5.33 4V2.67c0-.74.6-1.34 1.34-1.34h2.66c.74 0 1.34.6 1.34 1.34V4m2 0v9.33c0 .74-.6 1.34-1.34 1.34H4.67c-.74 0-1.34-.6-1.34-1.34V4h9.34z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
            </div>
            <div class="ap-blocks">
                ${Object.entries(TYPES).map(([k, v]) => `
                    <div class="ap-block" draggable="true" data-type="${k}" title="${v.desc}">
                        <span class="ap-block-indicator" style="background: ${v.color}"></span>
                        <span class="ap-block-name">${v.name}</span>
                    </div>
                `).join('')}
            </div>
            <div class="ap-sidebar-footer">
                <select id="ap-del-select"></select>
                <button class="ap-btn ap-btn-danger" id="ap-delete">Delete</button>
            </div>
        </aside>
        
        <main class="ap-main">
            <div id="ap-grid" class="ap-grid"></div>
        </main>
    </div>
</div>
${getStyles()}`;
    
    bindHeader();
    fillSelects();
    draw();
    syncUI();
};

const draw = () => {
    const grid = document.getElementById('ap-grid');
    if (!grid) return;
    
    const divs = window.divisions || {};
    const cols = Object.keys(divs).filter(d => divs[d]?.bunks?.length);
    
    if (!cols.length) {
        grid.innerHTML = `<div class="ap-empty"><div class="ap-empty-icon">📅</div><h3>No Divisions</h3><p>Configure divisions in Setup first</p></div>`;
        return;
    }
    
    const { lo, hi } = range();
    const h = (hi - lo) * PX_MIN;
    
    let html = `<div class="ap-schedule" style="--cols: ${cols.length}">`;
    
    // Corner
    html += `<div class="ap-corner"></div>`;
    
    // Headers
    cols.forEach(c => {
        const color = divs[c]?.color || '#007AFF';
        html += `<div class="ap-col-header" style="--col-color: ${color}">${esc(c)}</div>`;
    });
    
    // Time column
    html += `<div class="ap-time-col" style="height: ${h}px">`;
    for (let m = lo; m < hi; m += 30) {
        const top = (m - lo) * PX_MIN;
        const isHour = m % 60 === 0;
        html += `<div class="ap-time-label ${isHour ? 'ap-time-hour' : ''}" style="top: ${top}px">${toStr(m)}</div>`;
    }
    html += `</div>`;
    
    // Division columns
    cols.forEach(c => {
        const dv = divs[c];
        const ds = toMin(dv?.startTime), de = toMin(dv?.endTime);
        
        html += `<div class="ap-col" data-d="${esc(c)}" style="height: ${h}px">`;
        
        // Inactive zones
        if (ds != null && ds > lo) {
            html += `<div class="ap-inactive" style="top: 0; height: ${(ds - lo) * PX_MIN}px"></div>`;
        }
        if (de != null && de < hi) {
            html += `<div class="ap-inactive" style="top: ${(de - lo) * PX_MIN}px; height: ${(hi - de) * PX_MIN}px"></div>`;
        }
        
        // Hour lines
        for (let m = lo; m < hi; m += 60) {
            html += `<div class="ap-hour-line" style="top: ${(m - lo) * PX_MIN}px"></div>`;
        }
        
        // Events
        skeleton.filter(e => e.division === c).forEach(ev => {
            const s = toMin(ev.startTime), e = toMin(ev.endTime);
            if (s != null && e != null && e > s) {
                const top = (s - lo) * PX_MIN;
                const ht = (e - s) * PX_MIN;
                const T = TYPES[ev.type] || TYPES.custom;
                const small = ht < 36;
                const name = ev.event || T.name;
                
                html += `
                    <div class="ap-ev ${small ? 'ap-ev-small' : ''}" data-id="${ev.id}" draggable="true"
                         style="top: ${top}px; height: ${ht}px; --ev-color: ${T.color}; ${T.dashed ? 'border-style: dashed;' : ''}">
                        ${small ? '' : '<div class="ap-ev-handle ap-ev-handle-top"></div>'}
                        <div class="ap-ev-content">
                            <span class="ap-ev-name">${esc(name)}</span>
                            ${small ? '' : `<span class="ap-ev-time">${ev.startTime} – ${ev.endTime}</span>`}
                        </div>
                        ${small ? '' : '<div class="ap-ev-handle ap-ev-handle-bottom"></div>'}
                    </div>
                `;
            }
        });
        
        html += `</div>`;
    });
    
    html += `</div>`;
    grid.innerHTML = html;
    
    bindGrid();
};

// =================================================================
// EVENT BINDINGS
// =================================================================
const bindHeader = () => {
    document.getElementById('ap-load')?.addEventListener('click', () => {
        const n = document.getElementById('ap-tpl-select').value;
        if (!n) return toast('Select a template first');
        if (skeleton.length && !confirm('This will replace your current schedule. Continue?')) return;
        loadTpl(n);
    });
    
    document.getElementById('ap-save')?.addEventListener('click', () => {
        const n = document.getElementById('ap-save-name').value.trim();
        if (!n) return toast('Enter a template name');
        const all = window.getSavedSkeletons?.() || {};
        if (all[n] && !confirm(`"${n}" already exists. Replace it?`)) return;
        saveTpl(n, !!all[n]);
        document.getElementById('ap-save-name').value = '';
    });
    
    document.getElementById('ap-update')?.addEventListener('click', () => {
        if (template) saveTpl(template, true);
    });
    
    document.getElementById('ap-clear')?.addEventListener('click', () => {
        if (skeleton.length && !confirm('Clear entire schedule?')) return;
        skeleton = [];
        template = null;
        clearStorage();
        draw();
        syncUI();
    });
    
    document.getElementById('ap-delete')?.addEventListener('click', () => {
        const n = document.getElementById('ap-del-select').value;
        if (!n) return toast('Select a template to delete');
        if (!confirm(`Delete "${n}" permanently?`)) return;
        deleteTpl(n);
    });
    
    // Block drag from sidebar
    document.querySelectorAll('.ap-block').forEach(b => {
        b.addEventListener('dragstart', e => {
            e.dataTransfer.setData('block-type', b.dataset.type);
            b.classList.add('dragging');
        });
        b.addEventListener('dragend', () => b.classList.remove('dragging'));
    });
};

const bindGrid = () => {
    const { lo } = range();
    
    // Column events
    document.querySelectorAll('.ap-col').forEach(col => {
        col.addEventListener('mouseenter', () => { hoveredCol = col; });
        col.addEventListener('mouseleave', () => { if (hoveredCol === col) hoveredCol = null; });
        
        col.addEventListener('dragover', e => {
            e.preventDefault();
            col.classList.add('ap-col-dragover');
        });
        
        col.addEventListener('dragleave', e => {
            if (!col.contains(e.relatedTarget)) col.classList.remove('ap-col-dragover');
        });
        
        col.addEventListener('drop', e => {
            e.preventDefault();
            col.classList.remove('ap-col-dragover');
            
            // Move existing tile
            const moveId = e.dataTransfer.getData('move-id');
            if (moveId) {
                const ev = skeleton.find(x => x.id === moveId);
                if (ev) {
                    const rect = col.getBoundingClientRect();
                    const y = e.clientY - rect.top;
                    const newStart = lo + Math.round(y / PX_MIN / SNAP) * SNAP;
                    const dur = toMin(ev.endTime) - toMin(ev.startTime);
                    ev.division = col.dataset.d;
                    ev.startTime = toStr(newStart);
                    ev.endTime = toStr(newStart + dur);
                    save();
                    draw();
                }
                return;
            }
            
            // New tile from palette
            const blockType = e.dataTransfer.getData('block-type');
            if (blockType) {
                const rect = col.getBoundingClientRect();
                const y = e.clientY - rect.top;
                const startMin = lo + Math.round(y / PX_MIN / 15) * 15;
                modal(blockType, col.dataset.d, startMin);
            }
        });
    });
    
    // Event tile interactions
    document.querySelectorAll('.ap-ev').forEach(tile => {
        const id = tile.dataset.id;
        const ev = skeleton.find(x => x.id === id);
        
        // Select
        tile.addEventListener('click', e => {
            if (e.target.classList.contains('ap-ev-handle')) return;
            document.querySelectorAll('.ap-ev.selected').forEach(t => t.classList.remove('selected'));
            tile.classList.add('selected');
        });
        
        // Edit on double-click
        tile.addEventListener('dblclick', e => {
            if (e.target.classList.contains('ap-ev-handle')) return;
            if (ev) modal(ev.type, ev.division, null, ev);
        });
        
        // Delete on right-click
        tile.addEventListener('contextmenu', e => {
            e.preventDefault();
            if (confirm('Delete this event?')) {
                skeleton = skeleton.filter(x => x.id !== id);
                save();
                draw();
            }
        });
        
        // Drag to move
        tile.addEventListener('dragstart', e => {
            if (e.target.classList.contains('ap-ev-handle')) {
                e.preventDefault();
                return;
            }
            e.dataTransfer.setData('move-id', id);
            tile.style.opacity = '0.5';
        });
        
        tile.addEventListener('dragend', () => {
            tile.style.opacity = '1';
        });
        
        // Resize handles
        tile.querySelectorAll('.ap-ev-handle').forEach(handle => {
            const isTop = handle.classList.contains('ap-ev-handle-top');
            let startY, startTop, startHeight;
            
            const onMouseMove = e => {
                const delta = e.clientY - startY;
                if (isTop) {
                    const newTop = Math.round((startTop + delta) / (SNAP * PX_MIN)) * (SNAP * PX_MIN);
                    const newHeight = startHeight - (newTop - startTop);
                    if (newHeight >= 15) {
                        tile.style.top = newTop + 'px';
                        tile.style.height = newHeight + 'px';
                    }
                } else {
                    const newHeight = Math.max(15, Math.round((startHeight + delta) / (SNAP * PX_MIN)) * (SNAP * PX_MIN));
                    tile.style.height = newHeight + 'px';
                }
            };
            
            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                tile.classList.remove('resizing');
                
                if (ev) {
                    const newTop = parseFloat(tile.style.top);
                    const newHeight = parseFloat(tile.style.height);
                    ev.startTime = toStr(lo + newTop / PX_MIN);
                    ev.endTime = toStr(lo + (newTop + newHeight) / PX_MIN);
                    save();
                    draw();
                }
            };
            
            handle.addEventListener('mousedown', e => {
                e.preventDefault();
                e.stopPropagation();
                startY = e.clientY;
                startTop = parseFloat(tile.style.top);
                startHeight = parseFloat(tile.style.height);
                tile.classList.add('resizing');
                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            });
        });
    });
    
    // Deselect on click outside
    document.getElementById('ap-grid')?.addEventListener('click', e => {
        if (!e.target.closest('.ap-ev')) {
            document.querySelectorAll('.ap-ev.selected').forEach(t => t.classList.remove('selected'));
        }
    });
};

// =================================================================
// STYLES - APPLE DESIGN
// =================================================================
const getStyles = () => `<style>
/* ═══════════════════════════════════════════════════════════════
   APPLE DESIGN LANGUAGE
   ═══════════════════════════════════════════════════════════════ */

.ap {
    --font: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Helvetica Neue', sans-serif;
    --bg: #ffffff;
    --bg-secondary: #f5f5f7;
    --bg-tertiary: #e8e8ed;
    --text-primary: #1d1d1f;
    --text-secondary: #86868b;
    --text-tertiary: #aeaeb2;
    --border: rgba(0, 0, 0, 0.08);
    --border-strong: rgba(0, 0, 0, 0.12);
    --accent: #007AFF;
    --danger: #FF3B30;
    --success: #34C759;
    --warning: #FF9500;
    --radius-sm: 8px;
    --radius-md: 12px;
    --radius-lg: 16px;
    --shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.08);
    --shadow-md: 0 4px 16px rgba(0, 0, 0, 0.12);
    --shadow-lg: 0 8px 32px rgba(0, 0, 0, 0.16);
    --transition: 200ms ease;
    
    font-family: var(--font);
    background: var(--bg-secondary);
    color: var(--text-primary);
    display: flex;
    flex-direction: column;
    height: 100%;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
}

/* ═══════════════════════════════════════════════════════════════
   HEADER
   ═══════════════════════════════════════════════════════════════ */
.ap-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 24px;
    background: rgba(255, 255, 255, 0.8);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border-bottom: 1px solid var(--border);
}

.ap-header-title h1 {
    font-size: 28px;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin: 0;
}

.ap-status {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
}

.ap-badge {
    font-size: 11px;
    font-weight: 600;
    padding: 3px 8px;
    border-radius: 6px;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    background: var(--bg-tertiary);
    color: var(--text-secondary);
}

.ap-badge:empty { display: none; }
.ap-badge-draft { background: #FFF3E0; color: #E65100; }
.ap-badge-saved { background: #E8F5E9; color: #2E7D32; }

.ap-tpl-name {
    font-size: 14px;
    color: var(--text-secondary);
}

.ap-header-actions {
    display: flex;
    align-items: center;
    gap: 12px;
}

.ap-action-group {
    display: flex;
    align-items: center;
    gap: 8px;
}

.ap-divider {
    width: 1px;
    height: 24px;
    background: var(--border-strong);
}

/* ═══════════════════════════════════════════════════════════════
   FORM CONTROLS
   ═══════════════════════════════════════════════════════════════ */
.ap select,
.ap input[type="text"],
.ap-header input {
    height: 36px;
    padding: 0 12px;
    font: inherit;
    font-size: 14px;
    color: var(--text-primary);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    transition: all var(--transition);
}

.ap select:focus,
.ap input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(0, 122, 255, 0.2);
}

.ap select {
    cursor: pointer;
    min-width: 160px;
}

.ap-header input {
    width: 180px;
}

/* ═══════════════════════════════════════════════════════════════
   BUTTONS
   ═══════════════════════════════════════════════════════════════ */
.ap-btn {
    height: 36px;
    padding: 0 18px;
    font: inherit;
    font-size: 14px;
    font-weight: 500;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: all var(--transition);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
}

.ap-btn:active {
    transform: scale(0.97);
}

.ap-btn-primary {
    background: var(--accent);
    color: white;
}

.ap-btn-primary:hover {
    background: #0066CC;
}

.ap-btn-secondary {
    background: var(--bg-tertiary);
    color: var(--text-primary);
}

.ap-btn-secondary:hover {
    background: #d8d8dc;
}

.ap-btn-danger {
    background: transparent;
    color: var(--danger);
}

.ap-btn-danger:hover {
    background: rgba(255, 59, 48, 0.1);
}

.ap-icon-btn {
    width: 32px;
    height: 32px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-secondary);
    transition: all var(--transition);
}

.ap-icon-btn:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
}

/* ═══════════════════════════════════════════════════════════════
   LAYOUT
   ═══════════════════════════════════════════════════════════════ */
.ap-content {
    display: flex;
    flex: 1;
    overflow: hidden;
}

/* ═══════════════════════════════════════════════════════════════
   SIDEBAR
   ═══════════════════════════════════════════════════════════════ */
.ap-sidebar {
    width: 200px;
    background: var(--bg);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
}

.ap-sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
}

.ap-blocks {
    flex: 1;
    overflow-y: auto;
    padding: 0 8px 8px;
}

.ap-block {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    margin-bottom: 2px;
    border-radius: var(--radius-sm);
    cursor: grab;
    transition: all var(--transition);
    user-select: none;
}

.ap-block:hover {
    background: var(--bg-secondary);
}

.ap-block:active,
.ap-block.dragging {
    cursor: grabbing;
    background: var(--bg-tertiary);
    transform: scale(0.98);
}

.ap-block-indicator {
    width: 12px;
    height: 12px;
    border-radius: 4px;
    flex-shrink: 0;
}

.ap-block-name {
    font-size: 14px;
    color: var(--text-primary);
}

.ap-sidebar-footer {
    padding: 16px;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.ap-sidebar-footer select {
    width: 100%;
    min-width: auto;
    font-size: 13px;
}

/* ═══════════════════════════════════════════════════════════════
   MAIN / GRID
   ═══════════════════════════════════════════════════════════════ */
.ap-main {
    flex: 1;
    overflow: auto;
    padding: 20px;
}

.ap-grid {
    background: var(--bg);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    overflow: hidden;
}

.ap-schedule {
    display: grid;
    grid-template-columns: 60px repeat(var(--cols), minmax(120px, 1fr));
}

.ap-corner {
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
    border-right: 1px solid var(--border);
    position: sticky;
    left: 0;
    z-index: 3;
}

.ap-col-header {
    padding: 14px 12px;
    font-size: 13px;
    font-weight: 600;
    text-align: center;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: white;
    background: var(--col-color);
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 2;
}

.ap-time-col {
    position: relative;
    background: var(--bg-secondary);
    border-right: 1px solid var(--border);
    position: sticky;
    left: 0;
    z-index: 1;
}

.ap-time-label {
    position: absolute;
    right: 8px;
    font-size: 11px;
    font-weight: 500;
    color: var(--text-tertiary);
    transform: translateY(-50%);
}

.ap-time-hour {
    color: var(--text-secondary);
    font-weight: 600;
}

.ap-col {
    position: relative;
    background: var(--bg);
    border-right: 1px solid var(--border);
    transition: background var(--transition);
}

.ap-col:last-child {
    border-right: none;
}

.ap-col-dragover {
    background: rgba(0, 122, 255, 0.05);
}

.ap-hour-line {
    position: absolute;
    left: 0;
    right: 0;
    border-top: 1px solid var(--bg-secondary);
}

.ap-inactive {
    position: absolute;
    left: 0;
    right: 0;
    background: var(--bg-secondary);
    background-image: repeating-linear-gradient(
        -45deg,
        transparent,
        transparent 8px,
        rgba(0, 0, 0, 0.03) 8px,
        rgba(0, 0, 0, 0.03) 16px
    );
}

/* ═══════════════════════════════════════════════════════════════
   EVENTS
   ═══════════════════════════════════════════════════════════════ */
.ap-ev {
    position: absolute;
    left: 4px;
    right: 4px;
    background: color-mix(in srgb, var(--ev-color) 15%, white);
    border: 2px solid var(--ev-color);
    border-radius: var(--radius-sm);
    cursor: pointer;
    z-index: 2;
    overflow: hidden;
    transition: box-shadow var(--transition), transform var(--transition);
}

.ap-ev:hover {
    box-shadow: var(--shadow-md);
    transform: translateY(-1px);
    z-index: 3;
}

.ap-ev.selected {
    box-shadow: 0 0 0 3px rgba(0, 122, 255, 0.4);
    z-index: 4;
}

.ap-ev.resizing {
    z-index: 10;
    box-shadow: var(--shadow-lg);
}

.ap-ev-small {
    padding: 2px 6px;
}

.ap-ev-small:hover {
    box-shadow: 0 0 0 2px var(--danger);
}

.ap-ev-content {
    padding: 6px 10px;
}

.ap-ev-name {
    display: block;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.ap-ev-time {
    display: block;
    font-size: 11px;
    color: var(--text-secondary);
    margin-top: 2px;
}

.ap-ev-handle {
    position: absolute;
    left: 0;
    right: 0;
    height: 8px;
    cursor: ns-resize;
    opacity: 0;
    transition: opacity var(--transition);
}

.ap-ev-handle-top { top: 0; }
.ap-ev-handle-bottom { bottom: 0; }

.ap-ev:hover .ap-ev-handle {
    opacity: 1;
    background: linear-gradient(to bottom, rgba(0, 122, 255, 0.2), transparent);
}

.ap-ev:hover .ap-ev-handle-bottom {
    background: linear-gradient(to top, rgba(0, 122, 255, 0.2), transparent);
}

/* ═══════════════════════════════════════════════════════════════
   EMPTY STATE
   ═══════════════════════════════════════════════════════════════ */
.ap-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 80px 40px;
    text-align: center;
}

.ap-empty-icon {
    font-size: 48px;
    margin-bottom: 16px;
    opacity: 0.4;
}

.ap-empty h3 {
    margin: 0 0 8px;
    font-size: 20px;
    font-weight: 600;
}

.ap-empty p {
    margin: 0;
    color: var(--text-secondary);
}

/* ═══════════════════════════════════════════════════════════════
   MODAL
   ═══════════════════════════════════════════════════════════════ */
#ap-modal-wrap {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    animation: apFadeIn 200ms ease;
}

@keyframes apFadeIn {
    from { opacity: 0; }
}

.ap-modal {
    background: var(--bg);
    border-radius: var(--radius-lg);
    width: 420px;
    max-width: calc(100vw - 40px);
    max-height: calc(100vh - 40px);
    overflow: hidden;
    box-shadow: var(--shadow-lg);
    animation: apSlideUp 300ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

@keyframes apSlideUp {
    from { opacity: 0; transform: scale(0.95) translateY(20px); }
}

.ap-modal-bar {
    height: 4px;
}

.ap-modal-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 20px 24px;
    border-bottom: 1px solid var(--border);
}

.ap-modal-head h2 {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
}

.ap-modal-head p {
    margin: 4px 0 0;
    font-size: 14px;
    color: var(--text-secondary);
}

.ap-modal-close {
    width: 28px;
    height: 28px;
    padding: 0;
    background: var(--bg-tertiary);
    border: none;
    border-radius: 50%;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-secondary);
    transition: all var(--transition);
}

.ap-modal-close:hover {
    background: var(--bg-secondary);
    color: var(--text-primary);
}

.ap-modal-body {
    padding: 24px;
    overflow-y: auto;
    max-height: 60vh;
}

.ap-modal-foot {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    padding: 16px 24px;
    background: var(--bg-secondary);
}

/* Form Fields */
.ap-field {
    margin-bottom: 20px;
}

.ap-field:last-child {
    margin-bottom: 0;
}

.ap-field label {
    display: block;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-secondary);
    margin-bottom: 8px;
}

.ap-field input:not([type="checkbox"]),
.ap-field select {
    width: 100%;
    height: 44px;
    padding: 0 14px;
    font-size: 15px;
}

.ap-field-row {
    display: flex;
    gap: 16px;
}

.ap-field-row .ap-field {
    flex: 1;
}

/* Time Picker */
.ap-time {
    display: flex;
    align-items: center;
    gap: 12px;
}

.ap-time-input {
    display: flex;
    align-items: center;
    background: var(--bg-secondary);
    border-radius: var(--radius-sm);
    overflow: hidden;
}

.ap-time-input input {
    width: 90px !important;
    height: 44px;
    border: none !important;
    background: transparent !important;
    text-align: center;
    font-size: 15px !important;
    font-weight: 500;
}

.ap-time-input button {
    width: 40px;
    height: 44px;
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: 20px;
    font-weight: 300;
    color: var(--text-secondary);
    transition: all var(--transition);
}

.ap-time-input button:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
}

.ap-time-sep {
    color: var(--text-tertiary);
    font-size: 14px;
}

.ap-presets {
    display: flex;
    gap: 8px;
    margin-top: 12px;
}

.ap-presets button {
    padding: 8px 14px;
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-secondary);
    background: var(--bg-secondary);
    border: none;
    border-radius: 20px;
    cursor: pointer;
    transition: all var(--transition);
}

.ap-presets button:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
}

/* Checkboxes */
.ap-checks {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 6px;
    max-height: 160px;
    overflow-y: auto;
    padding: 12px;
    background: var(--bg-secondary);
    border-radius: var(--radius-sm);
}

.ap-checks label {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    background: var(--bg);
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 14px;
    font-weight: 400;
    color: var(--text-primary);
    transition: all var(--transition);
}

.ap-checks label:hover {
    background: var(--bg-tertiary);
}

.ap-checks input {
    width: 18px;
    height: 18px;
    margin: 0;
    accent-color: var(--accent);
}

.ap-checks small {
    margin-left: auto;
    font-size: 11px;
    color: var(--text-tertiary);
}

/* ═══════════════════════════════════════════════════════════════
   TOAST
   ═══════════════════════════════════════════════════════════════ */
#ap-toast {
    position: fixed;
    bottom: 32px;
    left: 50%;
    transform: translateX(-50%) translateY(16px);
    background: var(--text-primary);
    color: white;
    padding: 14px 24px;
    border-radius: var(--radius-md);
    font-size: 15px;
    font-weight: 500;
    opacity: 0;
    pointer-events: none;
    transition: all 300ms cubic-bezier(0.2, 0.8, 0.2, 1);
    z-index: 1001;
}

#ap-toast.show {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
}

/* ═══════════════════════════════════════════════════════════════
   RESPONSIVE
   ═══════════════════════════════════════════════════════════════ */
@media (max-width: 768px) {
    .ap-header {
        flex-direction: column;
        align-items: flex-start;
        gap: 16px;
    }
    
    .ap-header-actions {
        width: 100%;
        flex-wrap: wrap;
    }
    
    .ap-sidebar {
        width: 160px;
    }
    
    .ap-main {
        padding: 12px;
    }
}
</style>`;

// =================================================================
// INITIALIZATION
// =================================================================
const init = () => {
    container = document.getElementById('master-scheduler-content');
    if (!container) return;
    
    // Load saved draft or default
    if (!load()) {
        try {
            const assigns = window.getSkeletonAssignments?.() || {};
            const skels = window.getSavedSkeletons?.() || {};
            const dt = window.currentScheduleDate || '';
            const [y, m, d] = dt.split('-').map(Number);
            const dow = y && m && d ? new Date(y, m - 1, d).getDay() : 0;
            const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            const tpl = assigns[days[dow]] || assigns['Default'];
            skeleton = tpl && skels[tpl] ? JSON.parse(JSON.stringify(skels[tpl])) : [];
        } catch (e) {
            skeleton = [];
        }
    }
    
    render();
    setupKeyboard();
    setupVisibility();
};

const cleanup = () => {
    if (_keyHandler) document.removeEventListener('keydown', _keyHandler);
    if (_visHandler) document.removeEventListener('visibilitychange', _visHandler);
    if (_focusHandler) window.removeEventListener('focus', _focusHandler);
    document.getElementById('ap-modal-wrap')?.remove();
    document.getElementById('ap-toast')?.remove();
};

// Public API
window.initMasterScheduler = init;
window.cleanupMasterScheduler = cleanup;
window.refreshMasterSchedulerFromCloud = fillSelects;

})();
