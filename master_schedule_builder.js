// =================================================================
// SCHEDULE BUILDER v7.0 — GOOGLE-LEVEL DESIGN
// =================================================================
// Design Philosophy:
// - Content is king, UI fades into background
// - Generous whitespace, everything breathes
// - Subtle depth through refined shadows
// - Purposeful color, mostly neutral
// - Micro-interactions that delight
// - Every pixel earns its place
// =================================================================

(function() {
'use strict';

// State
let skeleton = [];
let template = null;
let container = null;

const STORAGE_KEY = 'scheduleBuilderDraft_v7';
const PX_MIN = 1.2;
const SNAP = 5;

// Refined color tokens - Google's muted palette
const TYPES = {
    activity:         { name: 'Activity',    hue: 210, sat: 90, desc: 'General activity slot' },
    sports:           { name: 'Sports',      hue: 142, sat: 70, desc: 'Sports period' },
    special:          { name: 'Special',     hue: 158, sat: 65, desc: 'Special activity' },
    smart:            { name: 'Smart',       hue: 217, sat: 85, desc: 'Auto-balanced slot', dashed: true },
    split:            { name: 'Split',       hue: 28,  sat: 85, desc: 'Divided time block' },
    elective:         { name: 'Elective',    hue: 270, sat: 70, desc: 'Choice-based' },
    league:           { name: 'League',      hue: 262, sat: 75, desc: 'League game' },
    specialty_league: { name: 'Specialty',   hue: 43,  sat: 90, desc: 'Specialty league' },
    swim:             { name: 'Swim',        hue: 199, sat: 85, desc: 'Swimming' },
    lunch:            { name: 'Lunch',       hue: 0,   sat: 70, desc: 'Lunch break' },
    snacks:           { name: 'Snacks',      hue: 35,  sat: 85, desc: 'Snack time' },
    dismissal:        { name: 'Dismissal',   hue: 0,   sat: 65, desc: 'End of day' },
    custom:           { name: 'Custom',      hue: 220, sat: 10, desc: 'Custom event' }
};

// Utilities
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

// Storage
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

const clear = () => { localStorage.removeItem(STORAGE_KEY); };

// Template ops
const loadTpl = name => {
    const all = window.getSavedSkeletons?.() || {};
    if (!all[name]) return;
    skeleton = JSON.parse(JSON.stringify(all[name]));
    template = name;
    clear();
    draw();
    toast('Template loaded');
};

const saveTpl = (name, update) => {
    if (!name) return;
    window.saveSkeleton?.(name, skeleton);
    window.forceSyncToCloud?.();
    template = name;
    clear();
    fillSelects();
    syncUI();
    toast(update ? 'Saved' : 'Template created');
};

const deleteTpl = name => {
    if (!name) return;
    window.deleteSkeleton?.(name);
    window.forceSyncToCloud?.();
    if (template === name) { template = null; skeleton = []; clear(); draw(); }
    fillSelects();
    syncUI();
    toast('Deleted');
};

// Toast
const toast = msg => {
    let t = document.getElementById('sb-toast');
    if (!t) { t = document.createElement('div'); t.id = 'sb-toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('on');
    setTimeout(() => t.classList.remove('on'), 2200);
};

// Sync header UI
const syncUI = () => {
    const badge = document.getElementById('sb-badge');
    const name = document.getElementById('sb-name');
    const upd = document.getElementById('sb-update');
    if (!badge) return;
    
    if (template) {
        badge.className = 'sb-badge sb-badge-saved';
        badge.textContent = 'Saved';
        name.textContent = template;
        if (upd) upd.style.display = '';
    } else if (skeleton.length) {
        badge.className = 'sb-badge sb-badge-draft';
        badge.textContent = 'Draft';
        name.textContent = 'Unsaved changes';
        if (upd) upd.style.display = 'none';
    } else {
        badge.className = 'sb-badge';
        badge.textContent = '';
        name.textContent = 'New schedule';
        if (upd) upd.style.display = 'none';
    }
};

const fillSelects = () => {
    const all = window.getSavedSkeletons?.() || {};
    const opts = Object.keys(all).sort().map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    const sel = document.getElementById('sb-tpl-select');
    const del = document.getElementById('sb-del-select');
    if (sel) sel.innerHTML = `<option value="">Choose template</option>${opts}`;
    if (del) del.innerHTML = `<option value="">Select to delete</option>${opts}`;
};

// =================================================================
// MODAL
// =================================================================
const modal = (type, div, startM, existing) => {
    const T = TYPES[type];
    if (!T) return;
    const { lo, hi } = range();
    let sM = existing ? toMin(existing.startTime) : (startM ?? lo);
    let eM = existing ? toMin(existing.endTime) : sM + 30;
    
    const locs = [];
    const gs = window.loadGlobalSettings?.() || {};
    (gs.app1?.fields || []).forEach(f => f.available !== false && locs.push({ n: f.name, c: 'Field' }));
    Object.values(gs.locationZones || {}).forEach(z => Object.keys(z.locations || {}).forEach(n => locs.find(l => l.n === n) || locs.push({ n, c: z.name || 'Zone' })));
    
    // Build fields
    let fields = '';
    if (type === 'custom') {
        fields = `<div class="sb-fg"><label>Event name</label><input id="mf-name" value="${esc(existing?.event || '')}" placeholder="Enter name" autofocus></div>`;
    } else if (type === 'smart') {
        fields = `
            <div class="sb-fg sb-fg-row"><div class="sb-fg"><label>Activity 1</label><input id="mf-a1" value="${esc(existing?.smartData?.activity1 || '')}"></div><div class="sb-fg"><label>Activity 2</label><input id="mf-a2" value="${esc(existing?.smartData?.activity2 || '')}"></div></div>
            <div class="sb-fg sb-fg-row"><div class="sb-fg"><label>Fallback for</label><select id="mf-ff"><option value="1">Activity 1</option><option value="2">Activity 2</option></select></div><div class="sb-fg"><label>Fallback</label><input id="mf-fb" value="${esc(existing?.smartData?.fallbackActivity || '')}"></div></div>
        `;
    } else if (type === 'split') {
        fields = `<div class="sb-fg sb-fg-row"><div class="sb-fg"><label>First half</label><input id="mf-s1" value="${esc(existing?.subEvents?.[0]?.activity || '')}"></div><div class="sb-fg"><label>Second half</label><input id="mf-s2" value="${esc(existing?.subEvents?.[1]?.activity || '')}"></div></div>`;
    } else if (type === 'elective') {
        const acts = [...(gs.app1?.fields || []).filter(f => f.available !== false).map(f => f.name), ...(gs.app1?.specialActivities || []).filter(s => s.available !== false).map(s => s.name)];
        const sel = existing?.electiveActivities || [];
        fields = `<div class="sb-fg"><label>Select activities</label><div class="sb-checks">${acts.map(a => `<label><input type="checkbox" name="el" value="${esc(a)}" ${sel.includes(a) ? 'checked' : ''}><span>${esc(a)}</span></label>`).join('')}</div></div>`;
    }
    
    let locHTML = '';
    if (type === 'custom' && locs.length) {
        const res = existing?.reservedFields || [];
        locHTML = `<div class="sb-fg"><label>Reserve locations</label><div class="sb-checks">${locs.map(l => `<label><input type="checkbox" name="loc" value="${esc(l.n)}" ${res.includes(l.n) ? 'checked' : ''}><span>${esc(l.n)}</span><em>${esc(l.c)}</em></label>`).join('')}</div></div>`;
    }
    
    const el = document.createElement('div');
    el.id = 'sb-modal-wrap';
    el.innerHTML = `
<div class="sb-modal">
    <header>
        <div class="sb-modal-color" style="--h:${T.hue};--s:${T.sat}%"></div>
        <div class="sb-modal-info"><h2>${existing ? 'Edit' : 'Add'} ${esc(T.name)}</h2><p>${esc(T.desc)}</p></div>
        <button class="sb-modal-x" id="mx">✕</button>
    </header>
    <main>
        ${fields}
        <div class="sb-fg">
            <label>Time</label>
            <div class="sb-time">
                <div class="sb-time-g"><button data-a="s-">−</button><input id="mf-s" value="${toStr(sM)}"><button data-a="s+">+</button></div>
                <span>to</span>
                <div class="sb-time-g"><button data-a="e-">−</button><input id="mf-e" value="${toStr(eM)}"><button data-a="e+">+</button></div>
            </div>
            <div class="sb-presets"><button data-d="15">15m</button><button data-d="30">30m</button><button data-d="45">45m</button><button data-d="60">1h</button></div>
        </div>
        ${locHTML}
    </main>
    <footer><button class="sb-btn-text" id="mc">Cancel</button><button class="sb-btn-fill" id="ms" style="--h:${T.hue};--s:${T.sat}%">${existing ? 'Save' : 'Add'}</button></footer>
</div>`;
    document.body.appendChild(el);
    
    const $s = document.getElementById('mf-s'), $e = document.getElementById('mf-e');
    const sync = () => { $s.value = toStr(sM); $e.value = toStr(eM); };
    $s.onblur = () => { const v = toMin($s.value); if (v != null) { sM = v; if (sM >= eM) eM = sM + 30; } sync(); };
    $e.onblur = () => { const v = toMin($e.value); if (v != null && v > sM) eM = v; sync(); };
    el.querySelectorAll('.sb-time button').forEach(b => b.onclick = () => {
        const a = b.dataset.a;
        if (a === 's+') sM = Math.min(sM + 5, eM - 5);
        else if (a === 's-') sM = Math.max(sM - 5, 0);
        else if (a === 'e+') eM = Math.min(eM + 5, 1439);
        else if (a === 'e-') eM = Math.max(eM - 5, sM + 5);
        sync();
    });
    el.querySelectorAll('.sb-presets button').forEach(b => b.onclick = () => { eM = sM + +b.dataset.d; sync(); });
    
    const close = () => el.remove();
    document.getElementById('mx').onclick = close;
    document.getElementById('mc').onclick = close;
    el.onclick = e => e.target === el && close();
    
    document.getElementById('ms').onclick = () => {
        const ev = existing ? { ...existing } : { id: uid(), type, event: T.name, division: div, reservedFields: [] };
        ev.startTime = toStr(sM); ev.endTime = toStr(eM);
        
        if (type === 'custom') {
            const n = document.getElementById('mf-name')?.value.trim();
            if (!n) return alert('Enter a name');
            ev.event = n;
            ev.reservedFields = [...el.querySelectorAll('input[name="loc"]:checked')].map(c => c.value);
        } else if (type === 'smart') {
            const a1 = document.getElementById('mf-a1')?.value.trim(), a2 = document.getElementById('mf-a2')?.value.trim(), fb = document.getElementById('mf-fb')?.value.trim();
            if (!a1 || !a2 || !fb) return alert('Fill all fields');
            ev.smartData = { activity1: a1, activity2: a2, fallbackFor: document.getElementById('mf-ff').value === '1' ? a1 : a2, fallbackActivity: fb };
        } else if (type === 'split') {
            const s1 = document.getElementById('mf-s1')?.value.trim(), s2 = document.getElementById('mf-s2')?.value.trim();
            if (!s1 || !s2) return alert('Fill both');
            const mid = sM + Math.floor((eM - sM) / 2);
            ev.subEvents = [{ activity: s1, startTime: toStr(sM), endTime: toStr(mid) }, { activity: s2, startTime: toStr(mid), endTime: toStr(eM) }];
        } else if (type === 'elective') {
            const acts = [...el.querySelectorAll('input[name="el"]:checked')].map(c => c.value);
            if (acts.length < 2) return alert('Select 2+');
            ev.electiveActivities = acts;
        }
        
        if (existing) { const i = skeleton.findIndex(x => x.id === existing.id); if (i >= 0) skeleton[i] = ev; }
        else skeleton.push(ev);
        close(); save(); draw();
    };
    
    setTimeout(() => el.querySelector('input:not([type="checkbox"])')?.focus(), 50);
};

// =================================================================
// RENDER
// =================================================================
const render = () => {
    if (!container) return;
    container.innerHTML = `
<div class="sb">
    <header class="sb-header">
        <div class="sb-header-l">
            <h1>Schedule Builder</h1>
            <span id="sb-badge" class="sb-badge"></span>
            <span id="sb-name" class="sb-name">New schedule</span>
        </div>
        <div class="sb-header-r">
            <select id="sb-tpl-select"></select>
            <button class="sb-btn-text" id="sb-load">Load</button>
            <button class="sb-btn-outline" id="sb-update" style="display:none">Update</button>
            <span class="sb-sep"></span>
            <input id="sb-save-input" placeholder="Template name...">
            <button class="sb-btn-fill" id="sb-save">Save</button>
        </div>
    </header>
    <div class="sb-body">
        <aside class="sb-side">
            <div class="sb-side-top">
                <span class="sb-side-label">Blocks</span>
                <button class="sb-icon-btn" id="sb-clear" title="Clear all">
                    <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>
                </button>
            </div>
            <div class="sb-blocks">${Object.entries(TYPES).map(([k, v]) => `<div class="sb-block" draggable="true" data-t="${k}" style="--h:${v.hue};--s:${v.sat}%" title="${v.desc}"><span class="sb-block-dot"></span>${v.name}</div>`).join('')}</div>
            <div class="sb-side-bot">
                <select id="sb-del-select"></select>
                <button class="sb-btn-danger" id="sb-del">Delete</button>
            </div>
        </aside>
        <div class="sb-main"><div id="sb-grid" class="sb-grid"></div></div>
    </div>
</div>
${css()}`;
    bindHeader();
    fillSelects();
    draw();
    syncUI();
};

const draw = () => {
    const g = document.getElementById('sb-grid');
    if (!g) return;
    const divs = window.divisions || {};
    const cols = Object.keys(divs).filter(d => divs[d]?.bunks?.length);
    if (!cols.length) { g.innerHTML = `<div class="sb-empty"><p>No divisions</p><span>Configure divisions first</span></div>`; return; }
    
    const { lo, hi } = range();
    const h = (hi - lo) * PX_MIN;
    
    let html = `<div class="sb-cols" style="--n:${cols.length}">`;
    // Corner
    html += `<div class="sb-corner"></div>`;
    // Headers
    cols.forEach(c => { const clr = divs[c]?.color || '#5f6368'; html += `<div class="sb-head" style="--c:${clr}">${esc(c)}</div>`; });
    // Time
    html += `<div class="sb-time-col" style="height:${h}px">`;
    for (let m = lo; m < hi; m += 30) html += `<div class="sb-tm ${m % 60 === 0 ? 'sb-tm-h' : ''}" style="top:${(m - lo) * PX_MIN}px">${toStr(m)}</div>`;
    html += `</div>`;
    // Columns
    cols.forEach(c => {
        const dv = divs[c], ds = toMin(dv?.startTime), de = toMin(dv?.endTime);
        html += `<div class="sb-col" data-d="${esc(c)}" style="height:${h}px">`;
        // Inactive
        if (ds != null && ds > lo) html += `<div class="sb-inactive" style="height:${(ds - lo) * PX_MIN}px"></div>`;
        if (de != null && de < hi) html += `<div class="sb-inactive sb-inactive-b" style="height:${(hi - de) * PX_MIN}px"></div>`;
        // Hour lines
        for (let m = lo; m < hi; m += 60) html += `<div class="sb-hline" style="top:${(m - lo) * PX_MIN}px"></div>`;
        // Events
        skeleton.filter(e => e.division === c).forEach(ev => {
            const s = toMin(ev.startTime), e = toMin(ev.endTime);
            if (s != null && e != null && e > s) {
                const top = (s - lo) * PX_MIN, ht = (e - s) * PX_MIN;
                const T = TYPES[ev.type] || TYPES.custom;
                const sm = ht < 36;
                html += `<div class="sb-ev${sm ? ' sb-ev-sm' : ''}" data-id="${ev.id}" draggable="true" style="top:${top}px;height:${ht}px;--h:${T.hue};--s:${T.sat}%;${T.dashed ? 'border-style:dashed;' : ''}">
                    ${sm ? '' : '<div class="sb-ev-r sb-ev-rt"></div>'}
                    <div class="sb-ev-c"><strong>${esc(ev.event || T.name)}</strong>${sm ? '' : `<span>${ev.startTime} – ${ev.endTime}</span>`}</div>
                    ${sm ? '' : '<div class="sb-ev-r sb-ev-rb"></div>'}
                </div>`;
            }
        });
        html += `</div>`;
    });
    html += `</div>`;
    g.innerHTML = html;
    bindGrid();
};

// =================================================================
// BINDINGS
// =================================================================
const bindHeader = () => {
    document.getElementById('sb-load')?.addEventListener('click', () => {
        const n = document.getElementById('sb-tpl-select').value;
        if (!n) return toast('Select a template');
        if (skeleton.length && !confirm('Replace current?')) return;
        loadTpl(n);
    });
    document.getElementById('sb-save')?.addEventListener('click', () => {
        const n = document.getElementById('sb-save-input').value.trim();
        if (!n) return toast('Enter name');
        const all = window.getSavedSkeletons?.() || {};
        if (all[n] && !confirm(`Overwrite "${n}"?`)) return;
        saveTpl(n, !!all[n]);
        document.getElementById('sb-save-input').value = '';
    });
    document.getElementById('sb-update')?.addEventListener('click', () => template && saveTpl(template, true));
    document.getElementById('sb-clear')?.addEventListener('click', () => {
        if (skeleton.length && !confirm('Clear?')) return;
        skeleton = []; template = null; clear(); draw(); syncUI();
    });
    document.getElementById('sb-del')?.addEventListener('click', () => {
        const n = document.getElementById('sb-del-select').value;
        if (!n || !confirm(`Delete "${n}"?`)) return;
        deleteTpl(n);
    });
    // Block drag
    document.querySelectorAll('.sb-block').forEach(b => {
        b.addEventListener('dragstart', e => { e.dataTransfer.setData('type', b.dataset.t); b.classList.add('dragging'); });
        b.addEventListener('dragend', () => b.classList.remove('dragging'));
    });
};

const bindGrid = () => {
    const { lo } = range();
    document.querySelectorAll('.sb-col').forEach(col => {
        col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('over'); });
        col.addEventListener('dragleave', e => { if (!col.contains(e.relatedTarget)) col.classList.remove('over'); });
        col.addEventListener('drop', e => {
            e.preventDefault(); col.classList.remove('over');
            const move = e.dataTransfer.getData('move');
            if (move) {
                const ev = skeleton.find(x => x.id === move);
                if (ev) {
                    const rect = col.getBoundingClientRect(), y = e.clientY - rect.top;
                    const ns = lo + Math.round(y / PX_MIN / SNAP) * SNAP;
                    const dur = toMin(ev.endTime) - toMin(ev.startTime);
                    ev.division = col.dataset.d; ev.startTime = toStr(ns); ev.endTime = toStr(ns + dur);
                    save(); draw();
                }
                return;
            }
            const type = e.dataTransfer.getData('type');
            if (type) {
                const rect = col.getBoundingClientRect(), y = e.clientY - rect.top;
                modal(type, col.dataset.d, lo + Math.round(y / PX_MIN / 15) * 15);
            }
        });
    });
    
    document.querySelectorAll('.sb-ev').forEach(tile => {
        const id = tile.dataset.id, ev = skeleton.find(x => x.id === id);
        tile.addEventListener('click', e => { if (!e.target.classList.contains('sb-ev-r')) { document.querySelectorAll('.sb-ev.sel').forEach(t => t.classList.remove('sel')); tile.classList.add('sel'); } });
        tile.addEventListener('dblclick', e => { if (!e.target.classList.contains('sb-ev-r') && ev) modal(ev.type, ev.division, null, ev); });
        tile.addEventListener('contextmenu', e => { e.preventDefault(); if (confirm('Delete?')) { skeleton = skeleton.filter(x => x.id !== id); save(); draw(); } });
        tile.addEventListener('dragstart', e => { if (e.target.classList.contains('sb-ev-r')) { e.preventDefault(); return; } e.dataTransfer.setData('move', id); tile.style.opacity = '0.4'; });
        tile.addEventListener('dragend', () => tile.style.opacity = '1');
        
        // Resize
        tile.querySelectorAll('.sb-ev-r').forEach(h => {
            const isT = h.classList.contains('sb-ev-rt');
            let y0, t0, h0;
            const move = e => {
                const d = e.clientY - y0;
                if (isT) { const nt = Math.round((t0 + d) / (SNAP * PX_MIN)) * (SNAP * PX_MIN), nh = h0 - (nt - t0); if (nh >= 12) { tile.style.top = nt + 'px'; tile.style.height = nh + 'px'; } }
                else { const nh = Math.max(12, Math.round((h0 + d) / (SNAP * PX_MIN)) * (SNAP * PX_MIN)); tile.style.height = nh + 'px'; }
            };
            const up = () => {
                document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); tile.classList.remove('resizing');
                if (ev) { const nt = parseFloat(tile.style.top), nh = parseFloat(tile.style.height); ev.startTime = toStr(lo + nt / PX_MIN); ev.endTime = toStr(lo + (nt + nh) / PX_MIN); save(); draw(); }
            };
            h.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); y0 = e.clientY; t0 = parseFloat(tile.style.top); h0 = parseFloat(tile.style.height); tile.classList.add('resizing'); document.addEventListener('mousemove', move); document.addEventListener('mouseup', up); });
        });
    });
    
    document.getElementById('sb-grid')?.addEventListener('click', e => { if (!e.target.closest('.sb-ev')) document.querySelectorAll('.sb-ev.sel').forEach(t => t.classList.remove('sel')); });
};

// =================================================================
// CSS
// =================================================================
const css = () => `<style>
/* ═══════════════════════════════════════════════════════════════
   GOOGLE-LEVEL DESIGN — SCHEDULE BUILDER
   ═══════════════════════════════════════════════════════════════ */

.sb {
    --ff: 'Google Sans', 'Segoe UI', system-ui, sans-serif;
    --bg: #fff;
    --bg2: #f8f9fa;
    --bg3: #f1f3f4;
    --border: #e0e0e0;
    --text: #202124;
    --text2: #5f6368;
    --text3: #80868b;
    --blue: #1a73e8;
    --red: #ea4335;
    --radius: 8px;
    --shadow: 0 1px 2px 0 rgba(60,64,67,.3), 0 1px 3px 1px rgba(60,64,67,.15);
    --shadow-lg: 0 1px 3px 0 rgba(60,64,67,.3), 0 4px 8px 3px rgba(60,64,67,.15);
    font-family: var(--ff);
    background: var(--bg2);
    color: var(--text);
    display: flex;
    flex-direction: column;
    height: 100%;
    -webkit-font-smoothing: antialiased;
}

/* HEADER */
.sb-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    padding: 12px 24px;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
}
.sb-header-l { display: flex; align-items: center; gap: 12px; }
.sb-header h1 { font-size: 22px; font-weight: 400; margin: 0; }
.sb-badge { font-size: 11px; font-weight: 500; padding: 2px 8px; border-radius: 4px; background: var(--bg3); color: var(--text3); text-transform: uppercase; letter-spacing: .3px; }
.sb-badge-draft { background: #fef7e0; color: #b06000; }
.sb-badge-saved { background: #e6f4ea; color: #137333; }
.sb-name { font-size: 14px; color: var(--text2); }
.sb-header-r { display: flex; align-items: center; gap: 8px; }
.sb-sep { width: 1px; height: 20px; background: var(--border); margin: 0 8px; }

/* INPUTS */
.sb select, .sb input[type="text"], .sb-header input {
    height: 36px; padding: 0 12px; font: inherit; font-size: 14px;
    border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg);
    transition: border-color .2s, box-shadow .2s;
}
.sb select:focus, .sb input:focus { outline: none; border-color: var(--blue); box-shadow: 0 0 0 2px rgba(26,115,232,.2); }
.sb select { cursor: pointer; }
.sb-header input { width: 160px; }

/* BUTTONS */
.sb-btn-fill, .sb-btn-outline, .sb-btn-text, .sb-btn-danger {
    height: 36px; padding: 0 16px; font: inherit; font-size: 14px; font-weight: 500;
    border: none; border-radius: var(--radius); cursor: pointer; transition: all .2s;
}
.sb-btn-fill { background: var(--blue); color: #fff; }
.sb-btn-fill:hover { background: #1557b0; box-shadow: var(--shadow); }
.sb-btn-outline { background: transparent; color: var(--blue); border: 1px solid var(--border); }
.sb-btn-outline:hover { background: rgba(26,115,232,.04); border-color: var(--blue); }
.sb-btn-text { background: transparent; color: var(--text2); }
.sb-btn-text:hover { background: var(--bg3); }
.sb-btn-danger { background: transparent; color: var(--red); font-size: 13px; }
.sb-btn-danger:hover { background: rgba(234,67,53,.08); }
.sb-icon-btn { width: 32px; height: 32px; padding: 0; background: none; border: none; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--text2); transition: background .2s; }
.sb-icon-btn:hover { background: var(--bg3); }
.sb-icon-btn svg { width: 18px; height: 18px; }

/* BODY */
.sb-body { display: flex; flex: 1; overflow: hidden; }

/* SIDEBAR */
.sb-side { width: 180px; background: var(--bg); border-right: 1px solid var(--border); display: flex; flex-direction: column; }
.sb-side-top { display: flex; align-items: center; justify-content: space-between; padding: 16px 12px 8px; }
.sb-side-label { font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: .5px; color: var(--text3); }
.sb-blocks { flex: 1; overflow-y: auto; padding: 4px 8px; }
.sb-block { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 6px; cursor: grab; font-size: 13px; color: var(--text); transition: background .15s; user-select: none; }
.sb-block:hover { background: var(--bg3); }
.sb-block.dragging { opacity: .5; }
.sb-block-dot { width: 8px; height: 8px; border-radius: 2px; background: hsl(var(--h), var(--s), 45%); flex-shrink: 0; }
.sb-side-bot { padding: 12px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; }
.sb-side-bot select { font-size: 13px; height: 32px; }

/* MAIN */
.sb-main { flex: 1; overflow: auto; }
.sb-grid { min-width: 100%; }
.sb-cols { display: grid; grid-template-columns: 56px repeat(var(--n), minmax(100px, 1fr)); }
.sb-corner { background: var(--bg2); border-bottom: 1px solid var(--border); border-right: 1px solid var(--border); position: sticky; left: 0; z-index: 3; }
.sb-head { padding: 10px 8px; font-size: 11px; font-weight: 500; text-align: center; text-transform: uppercase; letter-spacing: .5px; color: #fff; background: var(--c); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 2; }
.sb-time-col { position: relative; background: var(--bg2); border-right: 1px solid var(--border); position: sticky; left: 0; z-index: 1; }
.sb-tm { position: absolute; right: 8px; font-size: 10px; color: var(--text3); transform: translateY(-50%); }
.sb-tm-h { font-weight: 500; color: var(--text2); }
.sb-col { position: relative; border-right: 1px solid var(--border); background: var(--bg); transition: background .15s; }
.sb-col:last-child { border-right: none; }
.sb-col.over { background: rgba(26,115,232,.04); }
.sb-hline { position: absolute; left: 0; right: 0; border-top: 1px solid var(--bg3); }
.sb-inactive { position: absolute; left: 0; right: 0; top: 0; background: var(--bg3); }
.sb-inactive-b { top: auto; bottom: 0; }

/* EVENTS */
.sb-ev {
    position: absolute; left: 3px; right: 3px;
    background: hsl(var(--h), calc(var(--s) * .3), 95%);
    border-left: 3px solid hsl(var(--h), var(--s), 50%);
    border-radius: 4px;
    cursor: pointer;
    z-index: 2;
    transition: box-shadow .15s, transform .15s;
}
.sb-ev:hover { box-shadow: var(--shadow); transform: translateX(1px); z-index: 3; }
.sb-ev.sel { box-shadow: 0 0 0 2px var(--blue); z-index: 4; }
.sb-ev.resizing { z-index: 10; box-shadow: var(--shadow-lg); }
.sb-ev-sm { padding: 1px 6px; }
.sb-ev-sm:hover { box-shadow: 0 0 0 2px var(--red); }
.sb-ev-c { padding: 4px 8px; overflow: hidden; }
.sb-ev-c strong { display: block; font-size: 12px; font-weight: 500; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sb-ev-c span { display: block; font-size: 10px; color: var(--text2); margin-top: 1px; }
.sb-ev-r { position: absolute; left: 0; right: 0; height: 6px; cursor: ns-resize; opacity: 0; transition: opacity .15s; }
.sb-ev-rt { top: 0; }
.sb-ev-rb { bottom: 0; }
.sb-ev:hover .sb-ev-r { opacity: 1; background: rgba(26,115,232,.15); }

/* EMPTY */
.sb-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 300px; color: var(--text3); }
.sb-empty p { font-size: 16px; margin: 0; color: var(--text2); }
.sb-empty span { font-size: 13px; margin-top: 4px; }

/* MODAL */
#sb-modal-wrap { position: fixed; inset: 0; background: rgba(0,0,0,.32); display: flex; align-items: center; justify-content: center; z-index: 100; animation: fadeIn .15s; }
@keyframes fadeIn { from { opacity: 0 } }
.sb-modal { background: var(--bg); border-radius: 8px; width: 400px; max-width: calc(100vw - 32px); box-shadow: var(--shadow-lg); animation: slideUp .2s ease; overflow: hidden; }
@keyframes slideUp { from { opacity: 0; transform: translateY(8px) } }
.sb-modal header { display: flex; align-items: center; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--border); }
.sb-modal-color { width: 4px; height: 32px; border-radius: 2px; background: hsl(var(--h), var(--s), 50%); }
.sb-modal-info h2 { margin: 0; font-size: 16px; font-weight: 500; }
.sb-modal-info p { margin: 2px 0 0; font-size: 12px; color: var(--text2); }
.sb-modal-x { margin-left: auto; width: 32px; height: 32px; background: none; border: none; border-radius: 50%; cursor: pointer; font-size: 18px; color: var(--text3); transition: background .15s; display: flex; align-items: center; justify-content: center; }
.sb-modal-x:hover { background: var(--bg3); }
.sb-modal main { padding: 20px; }
.sb-modal footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px; background: var(--bg2); }

/* FORM */
.sb-fg { margin-bottom: 16px; }
.sb-fg:last-child { margin-bottom: 0; }
.sb-fg label { display: block; font-size: 12px; font-weight: 500; color: var(--text2); margin-bottom: 6px; }
.sb-fg input, .sb-fg select { width: 100%; height: 36px; }
.sb-fg-row { display: flex; gap: 12px; }
.sb-fg-row .sb-fg { flex: 1; margin-bottom: 16px; }

/* TIME */
.sb-time { display: flex; align-items: center; gap: 8px; }
.sb-time-g { display: flex; background: var(--bg2); border-radius: 6px; overflow: hidden; }
.sb-time-g input { width: 72px; border: none !important; background: transparent; text-align: center; font-weight: 500; }
.sb-time-g button { width: 32px; height: 36px; border: none; background: transparent; cursor: pointer; font-size: 16px; color: var(--text2); transition: background .15s; }
.sb-time-g button:hover { background: var(--bg3); }
.sb-time > span { color: var(--text3); font-size: 13px; }
.sb-presets { display: flex; gap: 6px; margin-top: 10px; }
.sb-presets button { padding: 4px 10px; font: inherit; font-size: 12px; background: var(--bg2); border: none; border-radius: 12px; cursor: pointer; color: var(--text2); transition: background .15s; }
.sb-presets button:hover { background: var(--bg3); color: var(--text); }

/* CHECKS */
.sb-checks { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; max-height: 140px; overflow-y: auto; padding: 8px; background: var(--bg2); border-radius: 6px; }
.sb-checks label { display: flex; align-items: center; gap: 6px; padding: 6px 8px; background: var(--bg); border-radius: 4px; cursor: pointer; font-size: 12px; transition: background .15s; }
.sb-checks label:hover { background: var(--bg3); }
.sb-checks input { margin: 0; accent-color: var(--blue); }
.sb-checks em { margin-left: auto; font-style: normal; font-size: 10px; color: var(--text3); }

/* TOAST */
#sb-toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(8px); background: #323232; color: #fff; padding: 10px 20px; border-radius: 6px; font-size: 14px; opacity: 0; transition: all .2s; z-index: 200; }
#sb-toast.on { opacity: 1; transform: translateX(-50%) translateY(0); }
</style>`;

// =================================================================
// INIT
// =================================================================
const init = () => {
    container = document.getElementById('master-scheduler-content');
    if (!container) return;
    if (!load()) {
        try {
            const asgn = window.getSkeletonAssignments?.() || {}, skels = window.getSavedSkeletons?.() || {};
            const dt = window.currentScheduleDate || '', [y, m, d] = dt.split('-').map(Number);
            const dow = y && m && d ? new Date(y, m - 1, d).getDay() : 0;
            const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
            const tpl = asgn[days[dow]] || asgn['Default'];
            skeleton = tpl && skels[tpl] ? JSON.parse(JSON.stringify(skels[tpl])) : [];
        } catch (e) { skeleton = []; }
    }
    render();
};

window.initMasterScheduler = init;
window.cleanupMasterScheduler = () => { document.getElementById('sb-modal-wrap')?.remove(); document.getElementById('sb-toast')?.remove(); };
window.refreshMasterSchedulerFromCloud = fillSelects;

})();
