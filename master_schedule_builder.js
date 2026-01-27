// =================================================================
// SCHEDULE BUILDER v9.0 — ULTIMATE DESIGN
// =================================================================
// Principles:
// 1. Content is everything - chrome disappears
// 2. Every interaction feels tactile
// 3. Whitespace is a feature
// 4. Simplicity is the ultimate sophistication
// 5. Details matter at every level
// =================================================================

(function() {
'use strict';

let skeleton = [];
let template = null;
let container = null;
let clipboard = null;
let hoveredCol = null;
let dragGhost = null;
let _keyHandler = null;
let _visHandler = null;

const STORE = 'sched_v9';
const PX = 1.6;
const SNAP = 5;

const BLOCKS = {
    activity:         { name: 'Activity',    color: '#4F46E5', bg: '#C7D2FE', desc: 'General activity slot. The scheduler will assign any available activity.' },
    sports:           { name: 'Sports',      color: '#059669', bg: '#A7F3D0', desc: 'Dedicated sports period. Assigns outdoor field activities and team sports.' },
    special:          { name: 'Special',     color: '#0891B2', bg: '#A5F3FC', desc: 'Special activity slot. For unique camp-wide events or guest activities.' },
    smart:            { name: 'Smart',       color: '#7C3AED', bg: '#DDD6FE', dashed: true, desc: 'Smart balanced slot. Automatically balances two activities with a fallback option.' },
    split:            { name: 'Split',       color: '#D97706', bg: '#FDE68A', desc: 'Split time block. Divides the period into two different activities.' },
    elective:         { name: 'Elective',    color: '#DB2777', bg: '#FBCFE8', desc: 'Elective choice period. Campers choose from a set of available activities.' },
    league:           { name: 'League',      color: '#5B21B6', bg: '#C4B5FD', desc: 'League game slot. Scheduled competitive games between bunks or teams.' },
    specialty_league: { name: 'Specialty',   color: '#B45309', bg: '#FCD34D', desc: 'Specialty league. Tournament or bracket-style competition events.' },
    swim:             { name: 'Swim',        color: '#0369A1', bg: '#7DD3FC', desc: 'Swimming period. Pool or lake activities with lifeguard supervision.' },
    lunch:            { name: 'Lunch',       color: '#DC2626', bg: '#FECACA', desc: 'Lunch break. Meal time - no activities scheduled.' },
    snacks:           { name: 'Snacks',      color: '#EA580C', bg: '#FDBA74', desc: 'Snack time. Short break for refreshments between activities.' },
    dismissal:        { name: 'Dismissal',   color: '#BE123C', bg: '#FDA4AF', desc: 'End of day dismissal. Wrap-up and departure time.' },
    custom:           { name: 'Custom',      color: '#475569', bg: '#CBD5E1', desc: 'Custom event. Define your own activity with optional location reservations.' }
};

// Utilities
const id = () => Math.random().toString(36).slice(2, 9);
const h = s => { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; };
const toM = s => { if (!s) return null; const t = s.toLowerCase().replace(/\s/g, ''); const pm = t.includes('pm'), am = t.includes('am'); let [hr, mn] = t.replace(/[ap]m/g, '').split(':').map(Number); if (isNaN(hr)) return null; if (pm && hr !== 12) hr += 12; if (am && hr === 12) hr = 0; return hr * 60 + (mn || 0); };
const toS = m => { if (m == null) return ''; let hr = Math.floor(m / 60), mn = m % 60; return `${hr % 12 || 12}:${String(mn).padStart(2, '0')} ${hr >= 12 ? 'PM' : 'AM'}`; };
const bounds = () => { const D = window.divisions || {}; let lo = null, hi = null; Object.values(D).filter(d => d?.bunks?.length).forEach(d => { const s = toM(d.startTime), e = toM(d.endTime); if (s != null && (lo == null || s < lo)) lo = s; if (e != null && (hi == null || e > hi)) hi = e; }); skeleton.forEach(ev => { const s = toM(ev.startTime), e = toM(ev.endTime); if (s != null && (lo == null || s < lo)) lo = s; if (e != null && (hi == null || e > hi)) hi = e; }); return { lo: lo ?? 480, hi: hi ?? 1020 }; };
const locs = () => { const g = window.loadGlobalSettings?.() || {}, r = []; (g.app1?.fields || []).forEach(f => f.available !== false && r.push({ n: f.name, t: 'Field' })); Object.values(g.locationZones || {}).forEach(z => Object.keys(z.locations || {}).forEach(n => r.find(x => x.n === n) || r.push({ n, t: z.name || 'Zone' }))); return r; };

// Storage
const save = () => { try { localStorage.setItem(STORE, JSON.stringify({ skeleton, template })); } catch(e){} sync(); };
const load = () => { try { const d = JSON.parse(localStorage.getItem(STORE) || '{}'); if (d.skeleton) { skeleton = d.skeleton; template = d.template; return true; } } catch(e){} return false; };
const clear = () => localStorage.removeItem(STORE);

// Templates
const loadT = n => { const all = window.getSavedSkeletons?.() || {}; if (!all[n]) return; skeleton = JSON.parse(JSON.stringify(all[n])); template = n; clear(); draw(); notify('Loaded'); };
const saveT = (n, u) => { if (!n) return; window.saveSkeleton?.(n, skeleton); window.forceSyncToCloud?.(); template = n; clear(); fills(); sync(); notify(u ? 'Updated' : 'Saved'); };
const delT = n => { if (!n) return; window.deleteSkeleton?.(n); window.forceSyncToCloud?.(); if (template === n) { template = null; skeleton = []; clear(); draw(); } fills(); sync(); notify('Deleted'); };
const fills = () => { const all = window.getSavedSkeletons?.() || {}, opts = Object.keys(all).sort().map(n => `<option value="${h(n)}">${h(n)}</option>`).join(''); const s1 = document.getElementById('tpl-sel'), s2 = document.getElementById('del-sel'); if (s1) s1.innerHTML = '<option value="">Load template...</option>' + opts; if (s2) s2.innerHTML = '<option value="">Delete...</option>' + opts; };

// Notify
const notify = msg => { let t = document.getElementById('notify'); if (!t) { t = document.createElement('div'); t.id = 'notify'; document.body.appendChild(t); } t.textContent = msg; t.classList.add('on'); setTimeout(() => t.classList.remove('on'), 2000); };

// Sync UI
const sync = () => { const b = document.getElementById('status-badge'), n = document.getElementById('status-name'), u = document.getElementById('btn-update'); if (!b) return; if (template) { b.className = 'badge saved'; b.textContent = 'Saved'; n.textContent = template; if(u)u.style.display = ''; } else if (skeleton.length) { b.className = 'badge draft'; b.textContent = 'Draft'; n.textContent = 'Unsaved'; if(u)u.style.display = 'none'; } else { b.className = 'badge'; b.textContent = ''; n.textContent = 'New'; if(u)u.style.display = 'none'; } };

// Keyboard
const keys = () => { _keyHandler = e => { const t = document.getElementById('master-scheduler'); if (!t || !t.classList.contains('active')) return; const sel = document.querySelector('.ev.sel'); if ((e.ctrlKey || e.metaKey) && e.key === 'c' && sel) { const ev = skeleton.find(x => x.id === sel.dataset.id); if (ev) { clipboard = { ...ev, id: null }; notify('Copied'); } e.preventDefault(); } if ((e.ctrlKey || e.metaKey) && e.key === 'v' && clipboard && hoveredCol) { const { lo } = bounds(); const dur = toM(clipboard.endTime) - toM(clipboard.startTime); skeleton.push({ ...clipboard, id: id(), division: hoveredCol.dataset.d, startTime: toS(lo), endTime: toS(lo + dur) }); save(); draw(); notify('Pasted'); e.preventDefault(); } if ((e.key === 'Delete' || e.key === 'Backspace') && sel && !e.target.matches('input,textarea,select')) { skeleton = skeleton.filter(x => x.id !== sel.dataset.id); save(); draw(); e.preventDefault(); } }; document.addEventListener('keydown', _keyHandler); };
const vis = () => { _visHandler = () => { if (document.visibilityState === 'visible') setTimeout(fills, 200); }; document.addEventListener('visibilitychange', _visHandler); window.addEventListener('focus', () => setTimeout(fills, 200)); };

// Modal
const modal = (type, div, start, existing) => {
    const B = BLOCKS[type]; if (!B) return;
    const { lo } = bounds();
    let sM = existing ? toM(existing.startTime) : (start ?? lo);
    let eM = existing ? toM(existing.endTime) : sM + 30;
    
    let fields = '';
    if (type === 'custom') fields = `<div class="mf"><label>Name</label><input id="f-name" value="${h(existing?.event || '')}" placeholder="Event name" autofocus></div>`;
    else if (type === 'smart') fields = `<div class="mf mf-row"><div class="mf"><label>Activity 1</label><input id="f-a1" value="${h(existing?.smartData?.activity1 || '')}"></div><div class="mf"><label>Activity 2</label><input id="f-a2" value="${h(existing?.smartData?.activity2 || '')}"></div></div><div class="mf mf-row"><div class="mf"><label>Fallback for</label><select id="f-ff"><option value="1">Activity 1</option><option value="2">Activity 2</option></select></div><div class="mf"><label>Fallback</label><input id="f-fb" value="${h(existing?.smartData?.fallbackActivity || '')}"></div></div>`;
    else if (type === 'split') fields = `<div class="mf mf-row"><div class="mf"><label>First half</label><input id="f-s1" value="${h(existing?.subEvents?.[0]?.activity || '')}"></div><div class="mf"><label>Second half</label><input id="f-s2" value="${h(existing?.subEvents?.[1]?.activity || '')}"></div></div>`;
    else if (type === 'elective') { const g = window.loadGlobalSettings?.() || {}, acts = [...(g.app1?.fields || []).filter(f => f.available !== false).map(f => f.name), ...(g.app1?.specialActivities || []).filter(s => s.available !== false).map(s => s.name)], sel = existing?.electiveActivities || []; fields = `<div class="mf"><label>Activities</label><div class="checks">${acts.map(a => `<label><input type="checkbox" name="el" value="${h(a)}" ${sel.includes(a) ? 'checked' : ''}><span>${h(a)}</span></label>`).join('')}</div></div>`; }
    
    let locHTML = '';
    if (type === 'custom') { const L = locs(), res = existing?.reservedFields || []; if (L.length) locHTML = `<div class="mf"><label>Locations</label><div class="checks">${L.map(l => `<label><input type="checkbox" name="loc" value="${h(l.n)}" ${res.includes(l.n) ? 'checked' : ''}><span>${h(l.n)}</span></label>`).join('')}</div></div>`; }
    
    const el = document.createElement('div'); el.id = 'modal-wrap';
    el.innerHTML = `<div class="modal"><div class="modal-accent" style="--c:${B.color}"></div><div class="modal-head"><div class="modal-icon" style="--c:${B.color}">${B.name[0]}</div><div><h2>${existing ? 'Edit' : 'Add'} ${h(B.name)}</h2></div><button class="modal-x" id="mx">×</button></div><div class="modal-body">${fields}<div class="mf"><label>Time</label><div class="time-row"><div class="time-box"><button data-a="s-">−</button><input id="f-s" value="${toS(sM)}"><button data-a="s+">+</button></div><span>→</span><div class="time-box"><button data-a="e-">−</button><input id="f-e" value="${toS(eM)}"><button data-a="e+">+</button></div></div><div class="dur-row"><button data-d="15">15m</button><button data-d="30">30m</button><button data-d="45">45m</button><button data-d="60">1h</button></div></div>${locHTML}</div><div class="modal-foot"><button class="btn btn-ghost" id="mc">Cancel</button><button class="btn btn-primary" id="ms" style="--c:${B.color}">${existing ? 'Save' : 'Add'}</button></div></div>`;
    document.body.appendChild(el);
    
    const $s = document.getElementById('f-s'), $e = document.getElementById('f-e');
    const sy = () => { $s.value = toS(sM); $e.value = toS(eM); };
    $s.onblur = () => { const v = toM($s.value); if (v != null) { sM = v; if (sM >= eM) eM = sM + 30; } sy(); };
    $e.onblur = () => { const v = toM($e.value); if (v != null && v > sM) eM = v; sy(); };
    el.querySelectorAll('.time-box button').forEach(b => b.onclick = () => { const a = b.dataset.a; if (a === 's+') sM = Math.min(sM + 5, eM - 5); else if (a === 's-') sM = Math.max(sM - 5, 0); else if (a === 'e+') eM = Math.min(eM + 5, 1439); else if (a === 'e-') eM = Math.max(eM - 5, sM + 5); sy(); });
    el.querySelectorAll('.dur-row button').forEach(b => b.onclick = () => { eM = sM + +b.dataset.d; sy(); });
    
    const close = () => el.remove();
    document.getElementById('mx').onclick = close;
    document.getElementById('mc').onclick = close;
    el.onclick = e => e.target === el && close();
    
    document.getElementById('ms').onclick = () => {
        const ev = existing ? { ...existing } : { id: id(), type, event: B.name, division: div, reservedFields: [] };
        ev.startTime = toS(sM); ev.endTime = toS(eM);
        if (type === 'custom') { const n = document.getElementById('f-name')?.value.trim(); if (!n) return alert('Enter name'); ev.event = n; ev.reservedFields = [...el.querySelectorAll('input[name="loc"]:checked')].map(c => c.value); }
        else if (type === 'smart') { const a1 = document.getElementById('f-a1')?.value.trim(), a2 = document.getElementById('f-a2')?.value.trim(), fb = document.getElementById('f-fb')?.value.trim(); if (!a1 || !a2 || !fb) return alert('Fill all fields'); ev.smartData = { activity1: a1, activity2: a2, fallbackFor: document.getElementById('f-ff').value === '1' ? a1 : a2, fallbackActivity: fb }; }
        else if (type === 'split') { const s1 = document.getElementById('f-s1')?.value.trim(), s2 = document.getElementById('f-s2')?.value.trim(); if (!s1 || !s2) return alert('Fill both'); const mid = sM + Math.floor((eM - sM) / 2); ev.subEvents = [{ activity: s1, startTime: toS(sM), endTime: toS(mid) }, { activity: s2, startTime: toS(mid), endTime: toS(eM) }]; }
        else if (type === 'elective') { const acts = [...el.querySelectorAll('input[name="el"]:checked')].map(c => c.value); if (acts.length < 2) return alert('Select 2+'); ev.electiveActivities = acts; }
        if (existing) { const i = skeleton.findIndex(x => x.id === existing.id); if (i >= 0) skeleton[i] = ev; } else skeleton.push(ev);
        close(); save(); draw();
    };
    setTimeout(() => el.querySelector('input:not([type="checkbox"])')?.focus(), 50);
};

// Render
const render = () => {
    if (!container) return;
    container.innerHTML = `<div class="sch">${css()}<div class="top"><div class="top-left"><h1>Schedule Builder</h1><span id="status-badge" class="badge"></span><span id="status-name" class="status-name">New</span></div><div class="top-right"><div class="tool-group"><label>Load</label><select id="tpl-sel"></select><button class="btn btn-ghost" id="btn-load">Load</button><button class="btn btn-ghost" id="btn-update" style="display:none">Update</button></div><div class="tool-group"><label>Save</label><input id="save-name" placeholder="Template name"><button class="btn btn-primary" id="btn-save">Save</button></div><div class="tool-group"><label>Manage</label><select id="del-sel"></select><button class="btn btn-danger" id="btn-del">Delete</button><button class="btn btn-ghost" id="btn-clear">Clear All</button></div></div></div><div class="body"><div class="side"><div class="side-head"><span>Tiles</span><span class="side-hint">Click for info</span></div><div class="blocks">${Object.entries(BLOCKS).map(([k, v]) => `<div class="block" draggable="true" data-type="${k}" data-desc="${h(v.desc)}"><span class="block-dot" style="--c:${v.color};--bg:${v.bg}"></span><span>${v.name}</span></div>`).join('')}</div></div><div class="main"><div id="grid" class="grid"></div></div></div><div id="tile-info" class="tile-info"></div></div>`;
    bindUI(); fills(); draw(); sync();
};

const draw = () => {
    const g = document.getElementById('grid'); if (!g) return;
    const D = window.divisions || {}, cols = Object.keys(D).filter(d => D[d]?.bunks?.length);
    if (!cols.length) { g.innerHTML = `<div class="empty"><div class="empty-icon">📅</div><p>No divisions configured</p></div>`; return; }
    
    const { lo, hi } = bounds(), ht = (hi - lo) * PX;
    let html = `<div class="calendar" style="--cols:${cols.length}"><div class="cal-corner"></div>`;
    
    // Headers
    cols.forEach(c => { const clr = D[c]?.color || '#6366F1'; html += `<div class="cal-head"><span class="cal-head-dot" style="--c:${clr}"></span><span>${h(c)}</span></div>`; });
    
    // Time rail
    html += `<div class="cal-times" style="height:${ht}px">`;
    for (let m = lo; m < hi; m += 60) html += `<div class="cal-time" style="top:${(m - lo) * PX}px">${toS(m)}</div>`;
    html += `</div>`;
    
    // Columns
    cols.forEach(c => {
        const dv = D[c], ds = toM(dv?.startTime), de = toM(dv?.endTime);
        html += `<div class="cal-col" data-d="${h(c)}" style="height:${ht}px">`;
        
        // Grid lines
        for (let m = lo; m < hi; m += 60) html += `<div class="cal-line" style="top:${(m - lo) * PX}px"></div>`;
        
        // Inactive
        if (ds != null && ds > lo) html += `<div class="cal-off" style="height:${(ds - lo) * PX}px"></div>`;
        if (de != null && de < hi) html += `<div class="cal-off cal-off-b" style="height:${(hi - de) * PX}px"></div>`;
        
        // Events
        skeleton.filter(e => e.division === c).forEach(ev => {
            const s = toM(ev.startTime), e = toM(ev.endTime);
            if (s != null && e != null && e > s) {
                const top = (s - lo) * PX, height = (e - s) * PX;
                const B = BLOCKS[ev.type] || BLOCKS.custom;
                const small = height < 36;
                const timeStr = `${ev.startTime} – ${ev.endTime}`;
                html += `<div class="ev ${small ? 'ev-sm' : ''}" data-id="${ev.id}" draggable="true" data-time="${timeStr}" style="top:${top}px;height:${Math.max(height, 22)}px;--c:${B.color};--bg:${B.bg};${B.dashed ? 'border-style:dashed;' : ''}"><div class="ev-body"><span class="ev-name">${h(ev.event || B.name)}</span>${small ? '' : `<span class="ev-time">${timeStr}</span>`}</div><div class="ev-handle ev-handle-t"></div><div class="ev-handle ev-handle-b"></div></div>`;
            }
        });
        html += `</div>`;
    });
    
    html += `</div>`;
    g.innerHTML = html;
    bindGrid();
};

const bindUI = () => {
    document.getElementById('btn-load')?.addEventListener('click', () => { const n = document.getElementById('tpl-sel').value; if (!n) return notify('Select template'); if (skeleton.length && !confirm('Replace current?')) return; loadT(n); });
    document.getElementById('btn-save')?.addEventListener('click', () => { const n = document.getElementById('save-name').value.trim(); if (!n) return notify('Enter name'); const all = window.getSavedSkeletons?.() || {}; if (all[n] && !confirm(`Replace "${n}"?`)) return; saveT(n, !!all[n]); document.getElementById('save-name').value = ''; });
    document.getElementById('btn-update')?.addEventListener('click', () => template && saveT(template, true));
    document.getElementById('btn-clear')?.addEventListener('click', () => { if (skeleton.length && !confirm('Clear entire schedule?')) return; skeleton = []; template = null; clear(); draw(); sync(); });
    document.getElementById('btn-del')?.addEventListener('click', () => { const n = document.getElementById('del-sel').value; if (!n || !confirm(`Delete "${n}"?`)) return; delT(n); });
    
    // Tile drag and click for info
    document.querySelectorAll('.block').forEach(b => {
        b.addEventListener('dragstart', e => { e.dataTransfer.setData('type', b.dataset.type); b.classList.add('dragging'); });
        b.addEventListener('dragend', () => b.classList.remove('dragging'));
        b.addEventListener('click', e => {
            if (e.detail === 1) { // Single click - show info
                const info = document.getElementById('tile-info');
                const rect = b.getBoundingClientRect();
                const type = b.dataset.type;
                const B = BLOCKS[type];
                info.innerHTML = `<div class="tile-info-header" style="--c:${B.color}"><span class="tile-info-dot" style="background:${B.color}"></span><strong>${B.name}</strong></div><p>${B.desc}</p><small>Drag to add to schedule</small>`;
                info.style.top = rect.top + 'px';
                info.style.left = (rect.right + 12) + 'px';
                info.classList.add('show');
                
                const hideInfo = () => { info.classList.remove('show'); document.removeEventListener('click', hideInfo); };
                setTimeout(() => document.addEventListener('click', hideInfo), 10);
            }
        });
    });
};

const bindGrid = () => {
    const { lo } = bounds();
    document.querySelectorAll('.cal-col').forEach(col => {
        col.addEventListener('mouseenter', () => hoveredCol = col);
        col.addEventListener('mouseleave', () => { if (hoveredCol === col) hoveredCol = null; });
        col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('over'); });
        col.addEventListener('dragleave', e => { if (!col.contains(e.relatedTarget)) col.classList.remove('over'); });
        col.addEventListener('drop', e => {
            e.preventDefault(); col.classList.remove('over');
            const mv = e.dataTransfer.getData('move');
            if (mv) { const ev = skeleton.find(x => x.id === mv); if (ev) { const r = col.getBoundingClientRect(), y = e.clientY - r.top, ns = lo + Math.round(y / PX / SNAP) * SNAP, dur = toM(ev.endTime) - toM(ev.startTime); ev.division = col.dataset.d; ev.startTime = toS(ns); ev.endTime = toS(ns + dur); save(); draw(); } return; }
            const type = e.dataTransfer.getData('type');
            if (type) { const r = col.getBoundingClientRect(), y = e.clientY - r.top; modal(type, col.dataset.d, lo + Math.round(y / PX / 15) * 15); }
        });
    });
    
    document.querySelectorAll('.ev').forEach(tile => {
        const eid = tile.dataset.id, ev = skeleton.find(x => x.id === eid);
        tile.addEventListener('click', e => { if (e.target.classList.contains('ev-handle')) return; document.querySelectorAll('.ev.sel').forEach(t => t.classList.remove('sel')); tile.classList.add('sel'); });
        tile.addEventListener('dblclick', e => { if (!e.target.classList.contains('ev-handle') && ev) modal(ev.type, ev.division, null, ev); });
        tile.addEventListener('contextmenu', e => { e.preventDefault(); if (confirm('Delete?')) { skeleton = skeleton.filter(x => x.id !== eid); save(); draw(); } });
        tile.addEventListener('dragstart', e => { if (e.target.classList.contains('ev-handle')) { e.preventDefault(); return; } e.dataTransfer.setData('move', eid); tile.classList.add('moving'); });
        tile.addEventListener('dragend', () => tile.classList.remove('moving'));
        
        tile.querySelectorAll('.ev-handle').forEach(hndl => {
            const isT = hndl.classList.contains('ev-handle-t');
            let y0, t0, h0;
            const move = e => { const d = e.clientY - y0; if (isT) { const nt = Math.round((t0 + d) / (SNAP * PX)) * (SNAP * PX), nh = h0 - (nt - t0); if (nh >= 20) { tile.style.top = nt + 'px'; tile.style.height = nh + 'px'; } } else { const nh = Math.max(20, Math.round((h0 + d) / (SNAP * PX)) * (SNAP * PX)); tile.style.height = nh + 'px'; } };
            const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); tile.classList.remove('resizing'); if (ev) { const nt = parseFloat(tile.style.top), nh = parseFloat(tile.style.height); ev.startTime = toS(lo + nt / PX); ev.endTime = toS(lo + (nt + nh) / PX); save(); draw(); } };
            hndl.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); y0 = e.clientY; t0 = parseFloat(tile.style.top); h0 = parseFloat(tile.style.height); tile.classList.add('resizing'); document.addEventListener('mousemove', move); document.addEventListener('mouseup', up); });
        });
    });
    
    document.getElementById('grid')?.addEventListener('click', e => { if (!e.target.closest('.ev')) document.querySelectorAll('.ev.sel').forEach(t => t.classList.remove('sel')); });
};

// CSS
const css = () => `<style>
/* ══════════════════════════════════════════════════════════════════════
   SCHEDULE BUILDER — CLEAN, PROFESSIONAL, FRIENDLY
   ══════════════════════════════════════════════════════════════════════ */

.sch {
    --bg: #F3F4F6;
    --surface: #FFFFFF;
    --border: #D1D5DB;
    --text: #1F2937;
    --text2: #4B5563;
    --text3: #6B7280;
    --accent: #4F46E5;
    font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;
    background: var(--bg);
    color: var(--text);
    height: 100%;
    display: flex;
    flex-direction: column;
    -webkit-font-smoothing: antialiased;
}

/* ═══════════ TOP BAR ═══════════ */
.top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    gap: 20px;
}
.top-left { display: flex; align-items: center; gap: 14px; }
.top h1 { font-size: 17px; font-weight: 600; margin: 0; color: var(--text); }
.badge { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; padding: 3px 8px; border-radius: 4px; background: var(--bg); color: var(--text3); }
.badge:empty { display: none; }
.badge.draft { background: #FEF3C7; color: #92400E; }
.badge.saved { background: #D1FAE5; color: #065F46; }
.status-name { font-size: 13px; color: var(--text3); }

.top-right { display: flex; align-items: center; gap: 24px; }
.tool-group { display: flex; align-items: center; gap: 6px; }
.tool-group label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text3); margin-right: 4px; }

/* ═══════════ CONTROLS ═══════════ */
select, input[type="text"], .top input {
    height: 32px;
    padding: 0 10px;
    font: inherit;
    font-size: 12px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    transition: all 0.15s;
}
select:focus, input:focus { outline: none; border-color: var(--accent); background: var(--surface); }
select { cursor: pointer; min-width: 120px; }
.top input { width: 120px; }

.btn {
    height: 32px;
    padding: 0 12px;
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s;
}
.btn:active { transform: scale(0.97); }
.btn-primary { background: var(--accent); color: white; }
.btn-primary:hover { background: #4338CA; }
.btn-ghost { background: var(--bg); color: var(--text2); border: 1px solid var(--border); }
.btn-ghost:hover { background: #E5E7EB; }
.btn-danger { background: #FEE2E2; color: #DC2626; }
.btn-danger:hover { background: #FECACA; }

/* ═══════════ LAYOUT ═══════════ */
.body { display: flex; flex: 1; overflow: hidden; }

/* ═══════════ SIDEBAR ═══════════ */
.side { width: 170px; background: var(--surface); border-right: 1px solid var(--border); display: flex; flex-direction: column; }
.side-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 12px 8px; }
.side-head span:first-child { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text3); }
.side-hint { font-size: 9px; color: var(--text3); font-style: italic; }
.blocks { flex: 1; padding: 4px 8px 8px; overflow-y: auto; }
.block { display: flex; align-items: center; gap: 10px; padding: 10px 10px; margin-bottom: 3px; border-radius: 6px; cursor: grab; transition: all 0.15s; border: 1px solid transparent; }
.block:hover { background: var(--bg); border-color: var(--border); }
.block.dragging { opacity: 0.5; cursor: grabbing; }
.block-dot { width: 20px; height: 20px; border-radius: 5px; background: var(--bg); border: 3px solid var(--c); }
.block span:last-child { font-size: 13px; font-weight: 500; color: var(--text2); }

/* ═══════════ TILE INFO POPUP ═══════════ */
.tile-info {
    position: fixed;
    z-index: 1000;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 16px;
    width: 260px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.15);
    opacity: 0;
    pointer-events: none;
    transform: translateX(-8px);
    transition: opacity 0.15s, transform 0.15s;
}
.tile-info.show { opacity: 1; pointer-events: auto; transform: translateX(0); }
.tile-info-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.tile-info-dot { width: 14px; height: 14px; border-radius: 4px; }
.tile-info-header strong { font-size: 14px; font-weight: 600; color: var(--text); }
.tile-info p { font-size: 13px; color: var(--text2); line-height: 1.5; margin: 0 0 10px; }
.tile-info small { font-size: 11px; color: var(--text3); font-style: italic; }

/* ═══════════ MAIN GRID ═══════════ */
.main { flex: 1; overflow: auto; padding: 16px; }
.grid { background: var(--surface); border-radius: 12px; border: 1px solid var(--border); overflow: hidden; }

.calendar { display: grid; grid-template-columns: 60px repeat(var(--cols), minmax(100px, 1fr)); }
.cal-corner { background: #E5E7EB; border-bottom: 1px solid var(--border); border-right: 1px solid var(--border); position: sticky; left: 0; z-index: 3; }

.cal-head {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 12px 8px;
    background: #E5E7EB;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--text2);
    position: sticky;
    top: 0;
    z-index: 2;
}
.cal-head-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--c); }

/* TIME COLUMN - MORE VISIBLE */
.cal-times {
    position: relative;
    background: #E5E7EB;
    border-right: 1px solid var(--border);
    position: sticky;
    left: 0;
    z-index: 1;
}
.cal-time {
    position: absolute;
    right: 8px;
    font-size: 11px;
    font-weight: 600;
    color: var(--text2);
    transform: translateY(-50%);
    background: #E5E7EB;
    padding: 2px 0;
}

.cal-col {
    position: relative;
    background: var(--surface);
    border-right: 1px solid var(--border);
    transition: background 0.15s;
}
.cal-col:last-child { border-right: none; }
.cal-col.over { background: #EEF2FF; }

.cal-line { position: absolute; left: 0; right: 0; border-top: 1px solid #E5E7EB; pointer-events: none; }

/* INACTIVE ZONES */
.cal-off { 
    position: absolute; 
    left: 0; 
    right: 0; 
    top: 0; 
    background: #9CA3AF;
    background-image: repeating-linear-gradient(
        -45deg,
        transparent,
        transparent 4px,
        rgba(75, 85, 99, 0.3) 4px,
        rgba(75, 85, 99, 0.3) 8px
    );
}
.cal-off-b { top: auto; bottom: 0; }

/* ═══════════ EVENTS — STRONG BORDERS ═══════════ */
.ev {
    position: absolute;
    left: 3px;
    right: 3px;
    min-height: 22px;
    background: var(--bg);
    border: 3px solid var(--c);
    border-radius: 6px;
    cursor: pointer;
    z-index: 2;
    overflow: visible;
    transition: transform 0.12s, box-shadow 0.12s;
    display: flex;
    flex-direction: column;
}
.ev:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 5;
}
.ev.sel {
    box-shadow: 0 0 0 3px var(--accent), 0 4px 12px rgba(0,0,0,0.12);
    z-index: 6;
}
.ev.moving { opacity: 0.7; }
.ev.resizing { z-index: 10; box-shadow: 0 8px 20px rgba(0,0,0,0.2); }

.ev-body { 
    flex: 1;
    padding: 4px 8px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-height: 0;
}
.ev-name { 
    display: block;
    font-size: 11px;
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.3;
}
.ev-time { 
    display: block;
    font-size: 10px;
    color: var(--text2);
    margin-top: 2px;
    line-height: 1.2;
}

/* Small events - SOLID TOOLTIP */
.ev-sm {
    min-height: 20px;
}
.ev-sm .ev-body { 
    padding: 2px 6px;
    flex-direction: row;
    align-items: center;
}
.ev-sm .ev-name { 
    font-size: 10px;
    font-weight: 600;
}

/* Tooltip for small events - SOLID BACKGROUND */
.ev-sm::after {
    content: attr(data-time);
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%) translateY(-6px);
    background: #1F2937;
    color: white;
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 500;
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s, transform 0.15s;
    z-index: 100;
    box-shadow: 0 4px 12px rgba(0,0,0,0.25);
}
.ev-sm::before {
    content: '';
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%) translateY(0);
    border: 6px solid transparent;
    border-top-color: #1F2937;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s;
    z-index: 100;
}
.ev-sm:hover::after,
.ev-sm:hover::before {
    opacity: 1;
}
.ev-sm:hover::after {
    transform: translateX(-50%) translateY(-8px);
}

.ev-sm:hover { 
    transform: scale(1.02);
    box-shadow: 0 0 0 2px var(--c), 0 4px 10px rgba(0,0,0,0.15);
    z-index: 20;
}

.ev-handle { position: absolute; left: 0; right: 0; height: 6px; cursor: ns-resize; opacity: 0; transition: opacity 0.15s; }
.ev-handle-t { top: 0; border-radius: 6px 6px 0 0; }
.ev-handle-b { bottom: 0; border-radius: 0 0 6px 6px; }
.ev:hover .ev-handle { opacity: 1; background: var(--c); opacity: 0.4; }

/* ═══════════ EMPTY ═══════════ */
.empty { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px 40px; }
.empty-icon { font-size: 36px; margin-bottom: 12px; opacity: 0.4; }
.empty p { margin: 0; color: var(--text3); font-size: 14px; }

/* ═══════════ MODAL ═══════════ */
#modal-wrap { position: fixed; inset: 0; background: rgba(0,0,0,0.4); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; z-index: 1000; animation: fadeIn 0.15s; }
@keyframes fadeIn { from { opacity: 0; } }
.modal { background: var(--surface); border-radius: 12px; width: 400px; max-width: calc(100vw - 32px); overflow: hidden; box-shadow: 0 20px 50px rgba(0,0,0,0.2); animation: slideUp 0.2s ease-out; }
@keyframes slideUp { from { opacity: 0; transform: translateY(16px); } }
.modal-accent { height: 4px; background: var(--c); }
.modal-head { display: flex; align-items: center; gap: 12px; padding: 16px 18px; border-bottom: 1px solid var(--border); }
.modal-icon { width: 38px; height: 38px; border-radius: 8px; background: var(--c); color: white; display: flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 700; }
.modal-head h2 { margin: 0; font-size: 16px; font-weight: 600; color: var(--text); }
.modal-x { margin-left: auto; width: 28px; height: 28px; background: var(--bg); border: none; border-radius: 6px; cursor: pointer; font-size: 16px; color: var(--text3); transition: all 0.15s; display: flex; align-items: center; justify-content: center; }
.modal-x:hover { background: var(--border); color: var(--text); }
.modal-body { padding: 18px; }
.modal-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 14px 18px; background: var(--bg); }

/* ═══════════ FORM ═══════════ */
.mf { margin-bottom: 14px; }
.mf:last-child { margin-bottom: 0; }
.mf label { display: block; font-size: 11px; font-weight: 600; color: var(--text3); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.03em; }
.mf input:not([type="checkbox"]), .mf select { width: 100%; height: 40px; font-size: 14px; background: var(--bg); border-color: transparent; border-radius: 8px; }
.mf input:focus, .mf select:focus { background: var(--surface); border-color: var(--border); }
.mf-row { display: flex; gap: 10px; }
.mf-row .mf { flex: 1; }

.time-row { display: flex; align-items: center; gap: 10px; }
.time-box { display: flex; align-items: center; background: var(--bg); border-radius: 8px; overflow: hidden; }
.time-box input { width: 70px !important; height: 40px; border: none !important; background: none !important; text-align: center; font-weight: 600; font-size: 14px !important; }
.time-box button { width: 34px; height: 40px; border: none; background: none; cursor: pointer; font-size: 16px; color: var(--text3); transition: all 0.15s; }
.time-box button:hover { background: var(--border); color: var(--text); }
.time-row > span { color: var(--text3); font-size: 12px; }

.dur-row { display: flex; gap: 6px; margin-top: 8px; }
.dur-row button { padding: 6px 12px; font: inherit; font-size: 12px; background: var(--bg); border: none; border-radius: 6px; cursor: pointer; color: var(--text2); transition: all 0.15s; }
.dur-row button:hover { background: var(--border); color: var(--text); }

.checks { display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px; max-height: 130px; overflow-y: auto; padding: 8px; background: var(--bg); border-radius: 8px; }
.checks label { display: flex; align-items: center; gap: 8px; padding: 8px; background: var(--surface); border-radius: 6px; cursor: pointer; font-size: 12px; transition: all 0.15s; }
.checks label:hover { background: var(--border); }
.checks input { width: 15px; height: 15px; margin: 0; accent-color: var(--accent); }

/* ═══════════ NOTIFY ═══════════ */
#notify { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%) translateY(12px); background: #1F2937; color: white; padding: 12px 24px; border-radius: 8px; font-size: 13px; font-weight: 500; opacity: 0; box-shadow: 0 4px 20px rgba(0,0,0,0.2); transition: all 0.2s ease-out; z-index: 1001; }
#notify.on { opacity: 1; transform: translateX(-50%) translateY(0); }

/* ═══════════ RESPONSIVE ═══════════ */
@media (max-width: 1100px) {
    .top { flex-wrap: wrap; }
    .top-right { flex-wrap: wrap; gap: 12px; }
}
</style>`;

// Init
const init = () => {
    container = document.getElementById('master-scheduler-content'); if (!container) return;
    if (!load()) { try { const a = window.getSkeletonAssignments?.() || {}, s = window.getSavedSkeletons?.() || {}, dt = window.currentScheduleDate || '', [y, m, d] = dt.split('-').map(Number), dow = y && m && d ? new Date(y, m - 1, d).getDay() : 0, days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'], t = a[days[dow]] || a['Default']; skeleton = t && s[t] ? JSON.parse(JSON.stringify(s[t])) : []; } catch(e) { skeleton = []; } }
    render(); keys(); vis();
};

window.initMasterScheduler = init;
window.cleanupMasterScheduler = () => { if (_keyHandler) document.removeEventListener('keydown', _keyHandler); if (_visHandler) document.removeEventListener('visibilitychange', _visHandler); document.getElementById('modal-wrap')?.remove(); document.getElementById('notify')?.remove(); };
window.refreshMasterSchedulerFromCloud = fills;

})();
