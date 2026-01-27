// =============================================================================
// master_schedule_builder.js v2.0 — PREMIUM SCHEDULE BUILDER
// =============================================================================
// Sleek, professional schedule builder interface
// Enterprise-grade design system
// =============================================================================

(function() {
'use strict';

let container, skeleton = [], template = null, _keyHandler, _visHandler;
const PX = 1.2, SNAP = 5;

// Premium Block Types with refined colors
const BLOCKS = {
    general:    { name: 'General',    color: '#475569', bg: '#f8fafc',   desc: 'Standard activity block' },
    rotation:   { name: 'Rotation',   color: '#4f46e5', bg: '#eef2ff',   desc: 'Rotating activity slot' },
    specialty:  { name: 'Specialty',  color: '#7c3aed', bg: '#f5f3ff',   desc: 'Specialized program' },
    split:      { name: 'Split',      color: '#0891b2', bg: '#ecfeff',   desc: 'Divided time block' },
    conditional:{ name: 'Conditional',color: '#ea580c', bg: '#fff7ed',   desc: 'Weather-dependent block' },
    elective:   { name: 'Elective',   color: '#059669', bg: '#ecfdf5',   desc: 'Camper choice activity' },
    league:     { name: 'League',     color: '#dc2626', bg: '#fef2f2',   desc: 'Competitive league slot' },
    lineup:     { name: 'Lineup',     color: '#64748b', bg: '#f1f5f9',   desc: 'Assembly/preparation', dashed: true },
    custom:     { name: 'Custom',     color: '#78716c', bg: '#fafaf9',   desc: 'Custom event type' }
};

// Helpers
const h = s => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'": '&#39;'})[c]);
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
const toM = t => { if (!t) return null; const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const toS = m => { const hh = Math.floor(m / 60) % 24, mm = m % 60; return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`; };
const notify = msg => { const el = document.getElementById('notify'); if (el) { el.textContent = msg; el.classList.add('on'); setTimeout(() => el.classList.remove('on'), 2500); } };

// Persistence
const load = () => { try { const d = localStorage.getItem('_msb_'); if (d) { const p = JSON.parse(d); skeleton = p.skeleton || []; template = p.template || null; return true; } } catch (e) {} return false; };
const save = () => { try { localStorage.setItem('_msb_', JSON.stringify({ skeleton, template })); } catch (e) {} sync(); };
const sync = () => { const b = document.getElementById('status-badge'), n = document.getElementById('status-name'), u = document.getElementById('btn-update'); if (b) { b.className = template ? 'badge saved' : 'badge draft'; b.textContent = template ? 'Saved' : 'Draft'; } if (n) n.textContent = template || 'Untitled'; if (u) u.style.display = template ? '' : 'none'; };

// Templates
const fills = () => { const all = window.getSavedSkeletons?.() || {}, names = Object.keys(all).sort(); ['tpl-sel', 'del-sel'].forEach(id => { const sel = document.getElementById(id); if (sel) { sel.innerHTML = '<option value="">— Select —</option>' + names.map(n => `<option value="${h(n)}">${h(n)}</option>`).join(''); } }); };
const loadT = n => { const all = window.getSavedSkeletons?.() || {}; if (all[n]) { skeleton = JSON.parse(JSON.stringify(all[n])); template = n; save(); draw(); notify(`Loaded "${n}"`); } };
const saveT = (n, upd) => { const all = window.getSavedSkeletons?.() || {}; all[n] = JSON.parse(JSON.stringify(skeleton)); window.setSavedSkeletons?.(all); template = n; save(); fills(); notify(upd ? `Updated "${n}"` : `Saved "${n}"`); };
const delT = () => { const n = document.getElementById('del-sel')?.value; if (!n || !confirm(`Delete template "${n}"?`)) return; const all = window.getSavedSkeletons?.() || {}; delete all[n]; window.setSavedSkeletons?.(all); if (template === n) template = null; save(); fills(); notify(`Deleted "${n}"`); };

// Bounds
const bounds = () => { const D = window.divisions || {}, times = Object.values(D).flatMap(d => [toM(d.startTime), toM(d.endTime)]).filter(t => t != null); if (!times.length) times.push(480, 1020); return { lo: Math.floor(Math.min(...times) / 60) * 60, hi: Math.ceil(Math.max(...times) / 60) * 60 }; };

// Keyboard
const keys = () => { if (_keyHandler) document.removeEventListener('keydown', _keyHandler); _keyHandler = e => { if (e.key === 'Delete' || e.key === 'Backspace') { const sel = document.querySelector('.ev.sel'); if (sel && !e.target.matches('input, textarea, select')) { e.preventDefault(); const id = sel.dataset.id; if (id && confirm('Delete this event?')) { skeleton = skeleton.filter(x => x.id !== id); save(); draw(); } } } }; document.addEventListener('keydown', _keyHandler); };
const vis = () => { if (_visHandler) document.removeEventListener('visibilitychange', _visHandler); _visHandler = () => { if (!document.hidden) { load(); draw(); fills(); } }; document.addEventListener('visibilitychange', _visHandler); };

// Drag & Drop
const bindGrid = () => {
    document.querySelectorAll('.block').forEach(bl => {
        bl.addEventListener('dragstart', e => { e.dataTransfer.setData('type', bl.dataset.type); bl.classList.add('dragging'); });
        bl.addEventListener('dragend', () => bl.classList.remove('dragging'));
        bl.addEventListener('click', e => { const info = document.getElementById('tile-info'); if (info) { const B = BLOCKS[bl.dataset.type]; info.innerHTML = `<div class="tile-info-header"><span class="tile-info-dot" style="background:${B.bg};border:2px solid ${B.color}"></span><strong>${B.name}</strong></div><p>${B.desc}</p><small>Drag onto calendar to add</small>`; const r = bl.getBoundingClientRect(); info.style.top = `${r.top}px`; info.style.left = `${r.right + 12}px`; info.classList.add('show'); setTimeout(() => info.classList.remove('show'), 2500); } });
    });
    
    document.querySelectorAll('.cal-col').forEach(col => {
        col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('over'); });
        col.addEventListener('dragleave', () => col.classList.remove('over'));
        col.addEventListener('drop', e => { e.preventDefault(); col.classList.remove('over'); const type = e.dataTransfer.getData('type'), move = e.dataTransfer.getData('move'); const { lo } = bounds(), y = e.offsetY, m = lo + Math.round(y / PX / SNAP) * SNAP, div = col.dataset.d; if (move) { const ev = skeleton.find(x => x.id === move); if (ev) { const dur = toM(ev.endTime) - toM(ev.startTime); ev.division = div; ev.startTime = toS(m); ev.endTime = toS(m + dur); save(); draw(); } } else if (type) { openModal(type, div, toS(m), toS(m + 40)); } });
    });
    
    document.querySelectorAll('.ev').forEach(tile => {
        const ev = skeleton.find(x => x.id === tile.dataset.id);
        tile.addEventListener('click', e => { if (!e.target.classList.contains('ev-handle')) { document.querySelectorAll('.ev.sel').forEach(t => t.classList.remove('sel')); tile.classList.add('sel'); } });
        tile.addEventListener('dblclick', () => { if (ev) openModal(ev.type, ev.division, ev.startTime, ev.endTime, ev); });
        tile.addEventListener('contextmenu', e => { e.preventDefault(); const eid = tile.dataset.id; if (eid && confirm('Delete this event?')) { skeleton = skeleton.filter(x => x.id !== eid); save(); draw(); } });
        tile.addEventListener('dragstart', e => { if (e.target.classList.contains('ev-handle')) { e.preventDefault(); return; } e.dataTransfer.setData('move', ev?.id); tile.classList.add('moving'); });
        tile.addEventListener('dragend', () => tile.classList.remove('moving'));
        
        tile.querySelectorAll('.ev-handle').forEach(hndl => {
            const isT = hndl.classList.contains('ev-handle-t');
            let y0, t0, h0;
            const move = e => { const d = e.clientY - y0; if (isT) { const nt = Math.round((t0 + d) / (SNAP * PX)) * (SNAP * PX), nh = h0 - (nt - t0); if (nh >= 20) { tile.style.top = nt + 'px'; tile.style.height = nh + 'px'; } } else { const nh = Math.max(20, Math.round((h0 + d) / (SNAP * PX)) * (SNAP * PX)); tile.style.height = nh + 'px'; } };
            const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); tile.classList.remove('resizing'); if (ev) { const nt = parseFloat(tile.style.top), nh = parseFloat(tile.style.height); ev.startTime = toS(bounds().lo + nt / PX); ev.endTime = toS(bounds().lo + (nt + nh) / PX); save(); draw(); } };
            hndl.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); y0 = e.clientY; t0 = parseFloat(tile.style.top); h0 = parseFloat(tile.style.height); tile.classList.add('resizing'); document.addEventListener('mousemove', move); document.addEventListener('mouseup', up); });
        });
    });
    
    document.getElementById('grid')?.addEventListener('click', e => { if (!e.target.closest('.ev')) document.querySelectorAll('.ev.sel').forEach(t => t.classList.remove('sel')); });
};

// Modal
const openModal = (type, division, start, end, existing) => {
    const B = BLOCKS[type] || BLOCKS.custom, sM = toM(start), eM = toM(end);
    document.getElementById('modal-wrap')?.remove();
    const wrap = document.createElement('div'); wrap.id = 'modal-wrap'; wrap.className = 'modal-wrap';
    const el = document.createElement('div'); el.className = 'modal';
    
    let extra = '';
    if (type === 'conditional') { const a1 = existing?.primaryActivity || '', a2 = existing?.secondaryActivity || '', fb = existing?.fallbackActivity || ''; extra = `<div class="mf"><label>Primary (Outdoor)</label><input id="f-a1" value="${h(a1)}" placeholder="e.g., Swimming"></div><div class="mf"><label>Secondary (Indoor)</label><input id="f-a2" value="${h(a2)}" placeholder="e.g., Arts"></div><div class="mf"><label>Fallback Activity</label><input id="f-fb" value="${h(fb)}" placeholder="Optional"></div>`; }
    else if (type === 'split') { const s1 = existing?.subEvents?.[0]?.activity || '', s2 = existing?.subEvents?.[1]?.activity || ''; extra = `<div class="mf"><label>First Half</label><input id="f-s1" value="${h(s1)}" placeholder="Activity 1"></div><div class="mf"><label>Second Half</label><input id="f-s2" value="${h(s2)}" placeholder="Activity 2"></div>`; }
    else if (type === 'elective') { const sp = window.loadGlobalSettings?.()?.sports || [], sel = existing?.electiveActivities || []; extra = `<div class="mf"><label>Available Activities</label><div class="checks">${sp.map(s => `<label><input type="checkbox" name="el" value="${h(s)}" ${sel.includes(s) ? 'checked' : ''}>${h(s)}</label>`).join('')}</div></div>`; }
    
    el.innerHTML = `<div class="modal-head"><span class="modal-icon" style="--c:${B.color}">${B.name[0]}</span><h2>${existing ? 'Edit' : 'Add'} ${B.name}</h2><button class="modal-x">×</button></div><div class="modal-body"><div class="mf"><label>Event Name</label><input id="f-name" value="${h(existing?.event || '')}" placeholder="${B.name}"></div><div class="mf-row"><div class="mf"><label>Start Time</label><div class="time-row"><div class="time-box"><button data-d="-5">−</button><input id="f-start" type="text" value="${start}"><button data-d="5">+</button></div></div></div><div class="mf"><label>End Time</label><div class="time-row"><div class="time-box"><button data-d="-5">−</button><input id="f-end" type="text" value="${end}"><button data-d="5">+</button></div></div></div></div><div class="dur-row"><button data-m="20">20m</button><button data-m="30">30m</button><button data-m="40">40m</button><button data-m="45">45m</button><button data-m="60">1h</button><button data-m="90">1.5h</button></div>${extra}</div><div class="modal-foot"><button class="btn btn-ghost" id="modal-cancel">Cancel</button><button class="btn btn-primary" id="modal-save">${existing ? 'Update' : 'Add'}</button></div>`;
    wrap.appendChild(el);
    document.body.appendChild(wrap);
    
    const close = () => wrap.remove();
    wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
    el.querySelector('.modal-x').onclick = close;
    document.getElementById('modal-cancel').onclick = close;
    
    el.querySelectorAll('.time-box button').forEach(btn => btn.onclick = () => { const inp = btn.parentElement.querySelector('input'), d = parseInt(btn.dataset.d), cur = toM(inp.value) || sM; inp.value = toS(Math.max(0, cur + d)); });
    el.querySelectorAll('.dur-row button').forEach(btn => btn.onclick = () => { const m = parseInt(btn.dataset.m), sInp = document.getElementById('f-start'), eInp = document.getElementById('f-end'), sVal = toM(sInp.value) || sM; eInp.value = toS(sVal + m); });
    
    document.getElementById('modal-save').onclick = () => {
        const name = document.getElementById('f-name').value.trim() || B.name, sT = document.getElementById('f-start').value, eT = document.getElementById('f-end').value, sMn = toM(sT), eMn = toM(eT);
        if (sMn == null || eMn == null || eMn <= sMn) return alert('Invalid times');
        const ev = existing ? { ...existing, event: name, startTime: sT, endTime: eT } : { id: uid(), type, division, event: name, startTime: sT, endTime: eT };
        if (type === 'conditional') { const a1 = document.getElementById('f-a1')?.value.trim(), a2 = document.getElementById('f-a2')?.value.trim(), fb = document.getElementById('f-fb')?.value.trim(); if (!a1 || !a2) return alert('Fill both activities'); ev.primaryActivity = a1; ev.secondaryActivity = a2; ev.conditionalType = 'weather'; ev.resolvedActivity = a1; ev.activities = fb ? [a1, a2, fb] : [a1, a2]; if (fb) ev.fallbackActivity = fb; }
        else if (type === 'split') { const s1 = document.getElementById('f-s1')?.value.trim(), s2 = document.getElementById('f-s2')?.value.trim(); if (!s1 || !s2) return alert('Fill both'); const mid = sMn + Math.floor((eMn - sMn) / 2); ev.subEvents = [{ activity: s1, startTime: toS(sMn), endTime: toS(mid) }, { activity: s2, startTime: toS(mid), endTime: toS(eMn) }]; }
        else if (type === 'elective') { const acts = [...el.querySelectorAll('input[name="el"]:checked')].map(c => c.value); if (acts.length < 2) return alert('Select 2+'); ev.electiveActivities = acts; }
        if (existing) { const i = skeleton.findIndex(x => x.id === existing.id); if (i >= 0) skeleton[i] = ev; } else skeleton.push(ev);
        close(); save(); draw();
    };
    setTimeout(() => el.querySelector('input:not([type="checkbox"])')?.focus(), 50);
};

// Render
const render = () => {
    if (!container) return;
    container.innerHTML = `<div class="sch">${css()}<div class="top"><div class="top-left"><h1>Schedule Builder</h1><span id="status-badge" class="badge"></span><span id="status-name" class="status-name">New</span></div><div class="top-right"><div class="tool-group"><label>Load</label><select id="tpl-sel"></select><button class="btn btn-ghost" id="btn-load">Load</button><button class="btn btn-ghost" id="btn-update" style="display:none">Update</button></div><div class="tool-group"><label>Save</label><input id="save-name" placeholder="Template name"><button class="btn btn-primary" id="btn-save">Save</button></div><div class="tool-group"><label>Manage</label><select id="del-sel"></select><button class="btn btn-danger" id="btn-del">Delete</button><button class="btn btn-ghost" id="btn-clear">Clear All</button></div></div></div><div class="body"><div class="side"><div class="side-head"><span>Block Types</span><span class="side-hint">Drag to calendar</span></div><div class="blocks">${Object.entries(BLOCKS).map(([k, v]) => `<div class="block" draggable="true" data-type="${k}" data-desc="${h(v.desc)}"><span class="block-dot" style="--c:${v.color};--bg:${v.bg}">${v.name[0]}</span><span>${v.name}</span></div>`).join('')}</div></div><div class="main"><div id="grid" class="grid"></div></div></div><div id="tile-info" class="tile-info"></div></div>`;
    bindUI(); fills(); draw(); sync();
};

const draw = () => {
    const g = document.getElementById('grid'); if (!g) return;
    const D = window.divisions || {}, cols = Object.keys(D).filter(d => D[d]?.bunks?.length);
    if (!cols.length) { g.innerHTML = `<div class="empty"><svg width="48" height="48" fill="none" stroke="#94a3b8" stroke-width="1.5" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg><p>No divisions configured</p><small>Add divisions in Setup to begin</small></div>`; return; }
    
    const { lo, hi } = bounds(), ht = (hi - lo) * PX;
    let html = `<div class="calendar" style="--cols:${cols.length}"><div class="cal-corner"></div>`;
    
    // Headers
    cols.forEach(c => { const clr = D[c]?.color || '#64748b'; html += `<div class="cal-head"><span class="cal-head-dot" style="--c:${clr}"></span><span>${h(c)}</span></div>`; });
    
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
                const top = (s - lo) * PX, height = (e - s) * PX - 1;
                const B = BLOCKS[ev.type] || BLOCKS.custom;
                const small = height < 32;
                const timeStr = `${ev.startTime} – ${ev.endTime}`;
                html += `<div class="ev ${small ? 'ev-sm' : ''}" data-id="${ev.id}" draggable="true" data-time="${timeStr}" style="top:${top}px;height:${Math.max(height, 20)}px;--c:${B.color};--bg:${B.bg};${B.dashed ? 'border-style:dashed;' : ''}"><div class="ev-body"><span class="ev-name">${h(ev.event || B.name)}</span>${small ? '' : `<span class="ev-time">${timeStr}</span>`}</div><div class="ev-handle ev-handle-t"></div><div class="ev-handle ev-handle-b"></div></div>`;
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
    document.getElementById('btn-clear')?.addEventListener('click', () => { if (skeleton.length && !confirm('Clear entire schedule?')) return; skeleton = []; template = null; save(); draw(); notify('Cleared'); });
    document.getElementById('btn-del')?.addEventListener('click', delT);
};

// ═══════════════════════════════════════════════════════════════════════════
// PREMIUM CSS — SLEEK, PROFESSIONAL, ENTERPRISE-GRADE
// ═══════════════════════════════════════════════════════════════════════════

const css = () => `<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

/* ══════════════════════════════════════════════════════════════════════════════
   SCHEDULE BUILDER — PREMIUM ENTERPRISE DESIGN SYSTEM
   A refined, sophisticated interface for professional schedule management
   ══════════════════════════════════════════════════════════════════════════════ */

.sch {
    /* Premium color system - sophisticated neutrals with depth */
    --bg: #fafbfc;
    --surface: #ffffff;
    --surface-elevated: #ffffff;
    --border: #e8ecf0;
    --border-subtle: #f0f3f5;
    --border-strong: #d0d6dc;
    
    /* Text hierarchy with proper contrast */
    --text-primary: #0f1419;
    --text-secondary: #536471;
    --text-tertiary: #8899a6;
    --text-placeholder: #a3b1bf;
    
    /* Premium accent - refined indigo */
    --accent: #4f46e5;
    --accent-hover: #4338ca;
    --accent-light: #eef2ff;
    --accent-subtle: #f5f7ff;
    
    /* Status colors - muted, professional */
    --success: #059669;
    --success-light: #ecfdf5;
    --warning: #d97706;
    --warning-light: #fffbeb;
    --danger: #dc2626;
    --danger-light: #fef2f2;
    
    /* Premium shadows - layered for depth */
    --shadow-xs: 0 1px 2px rgba(15, 20, 25, 0.04);
    --shadow-sm: 0 1px 3px rgba(15, 20, 25, 0.06), 0 1px 2px rgba(15, 20, 25, 0.04);
    --shadow-md: 0 4px 6px -1px rgba(15, 20, 25, 0.06), 0 2px 4px -1px rgba(15, 20, 25, 0.04);
    --shadow-lg: 0 10px 15px -3px rgba(15, 20, 25, 0.08), 0 4px 6px -2px rgba(15, 20, 25, 0.04);
    --shadow-xl: 0 20px 25px -5px rgba(15, 20, 25, 0.08), 0 10px 10px -5px rgba(15, 20, 25, 0.02);
    --shadow-focus: 0 0 0 3px rgba(79, 70, 229, 0.12);
    
    /* Typography */
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-feature-settings: 'cv02', 'cv03', 'cv04', 'cv11';
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    
    background: var(--bg);
    color: var(--text-primary);
    height: 100%;
    display: flex;
    flex-direction: column;
    position: relative;
    z-index: 1;
}

/* Premium Scrollbar */
.sch ::-webkit-scrollbar { width: 8px; height: 8px; }
.sch ::-webkit-scrollbar-track { background: transparent; }
.sch ::-webkit-scrollbar-thumb { 
    background: var(--border-strong); 
    border-radius: 4px;
    border: 2px solid transparent;
    background-clip: content-box;
}
.sch ::-webkit-scrollbar-thumb:hover { background: var(--text-tertiary); background-clip: content-box; }

/* ═══════════ TOP BAR — Executive Header ═══════════ */
.top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 24px;
    height: 64px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    position: relative;
    z-index: 100;
}

.top-left { 
    display: flex; 
    align-items: center; 
    gap: 16px; 
}

.top h1 { 
    font-size: 16px; 
    font-weight: 600; 
    margin: 0; 
    color: var(--text-primary);
    letter-spacing: -0.01em;
}

.badge { 
    padding: 4px 10px; 
    border-radius: 100px; 
    font-size: 11px; 
    font-weight: 600; 
    display: inline-flex; 
    align-items: center; 
    gap: 6px;
    letter-spacing: 0.01em;
}
.badge:empty { display: none; }
.badge::before { 
    content: ''; 
    width: 6px; 
    height: 6px; 
    border-radius: 50%; 
    background: currentColor;
    flex-shrink: 0;
}
.badge.draft { 
    background: var(--warning-light); 
    color: var(--warning); 
}
.badge.saved { 
    background: var(--success-light); 
    color: var(--success); 
}

.status-name { 
    font-size: 13px; 
    color: var(--text-secondary); 
    font-weight: 500;
}

.top-right { 
    display: flex; 
    align-items: center; 
    gap: 12px; 
}

.tool-group { 
    display: flex; 
    align-items: center; 
    gap: 8px;
    padding-left: 12px;
    border-left: 1px solid var(--border-subtle);
}
.tool-group:first-child {
    padding-left: 0;
    border-left: none;
}
.tool-group label { display: none; }

/* ═══════════ CONTROLS — Refined Inputs ═══════════ */
select, input[type="text"], .top input {
    background: var(--surface);
    border: 1px solid var(--border);
    font-family: inherit;
    font-size: 13px;
    font-weight: 500;
    padding: 8px 12px;
    border-radius: 8px;
    color: var(--text-primary);
    outline: none;
    transition: all 0.15s ease;
    min-width: 140px;
}
select:hover, input:hover { 
    border-color: var(--border-strong); 
}
select:focus, input:focus { 
    border-color: var(--accent); 
    box-shadow: var(--shadow-focus); 
}
select { 
    cursor: pointer;
    padding-right: 32px;
    background-image: url("data:image/svg+xml,%3Csvg width='12' height='12' viewBox='0 0 12 12' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%23536471' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 10px center;
    appearance: none;
}

.btn {
    padding: 8px 16px;
    border-radius: 8px;
    font-family: inherit;
    font-weight: 600;
    font-size: 13px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-primary);
    cursor: pointer;
    transition: all 0.15s ease;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    white-space: nowrap;
}
.btn:hover { 
    background: var(--bg);
    border-color: var(--border-strong);
}
.btn:active { 
    transform: scale(0.98); 
}

.btn-primary { 
    background: var(--accent); 
    color: white; 
    border-color: var(--accent);
    box-shadow: var(--shadow-sm);
}
.btn-primary:hover { 
    background: var(--accent-hover); 
    border-color: var(--accent-hover);
    box-shadow: var(--shadow-md);
}

.btn-ghost { 
    background: transparent; 
    border-color: transparent; 
}
.btn-ghost:hover { 
    background: var(--bg); 
    border-color: var(--border); 
}

.btn-danger { 
    background: var(--danger-light); 
    color: var(--danger); 
    border-color: #fecaca; 
}
.btn-danger:hover { 
    background: #fee2e2;
    border-color: #fca5a5;
}

/* ═══════════ LAYOUT ═══════════ */
.body { 
    display: flex; 
    flex: 1; 
    overflow: hidden; 
}

/* ═══════════ SIDEBAR — Premium Tile Palette ═══════════ */
.side { 
    width: 240px; 
    background: var(--surface); 
    border-right: 1px solid var(--border); 
    display: flex; 
    flex-direction: column;
    overflow: hidden;
}

.side-head { 
    display: flex; 
    align-items: center; 
    justify-content: space-between; 
    padding: 20px 20px 16px;
    border-bottom: 1px solid var(--border-subtle);
}
.side-head span:first-child { 
    font-size: 11px; 
    font-weight: 700; 
    color: var(--text-tertiary);
    text-transform: uppercase; 
    letter-spacing: 0.08em; 
}
.side-hint { 
    font-size: 11px; 
    color: var(--text-placeholder);
    font-weight: 500;
}

.blocks { 
    flex: 1; 
    padding: 16px; 
    overflow-y: auto; 
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
    align-content: start;
}

.block { 
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 16px 12px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    cursor: grab;
    transition: all 0.2s ease;
}
.block:hover { 
    border-color: var(--accent);
    background: var(--accent-subtle);
    box-shadow: var(--shadow-sm);
    transform: translateY(-1px);
}
.block:active { 
    cursor: grabbing; 
    transform: scale(0.97);
    box-shadow: none;
}
.block.dragging { 
    opacity: 0.5; 
}

.block-dot { 
    width: 36px; 
    height: 36px; 
    border-radius: 10px;
    border: 2px solid var(--c);
    background: var(--bg);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--c);
    font-weight: 700;
    font-size: 14px;
    transition: all 0.15s ease;
}
.block:hover .block-dot {
    background: white;
    box-shadow: var(--shadow-xs);
}

.block span:last-child { 
    font-size: 11px; 
    font-weight: 600; 
    color: var(--text-secondary);
    text-align: center;
    line-height: 1.3;
}

/* ═══════════ EMPTY STATE — Elegant Placeholder ═══════════ */
.empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 48px;
    color: var(--text-tertiary);
    text-align: center;
}
.empty svg {
    margin-bottom: 16px;
    opacity: 0.5;
}
.empty p {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-secondary);
    margin: 0 0 4px;
}
.empty small {
    font-size: 13px;
    color: var(--text-tertiary);
}

/* ═══════════ TILE INFO POPUP — Premium Tooltip ═══════════ */
.tile-info {
    position: fixed;
    z-index: 9000;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px;
    width: 260px;
    box-shadow: var(--shadow-xl);
    opacity: 0;
    pointer-events: none;
    transform: translateX(-8px);
    transition: all 0.2s ease;
}
.tile-info.show { 
    opacity: 1; 
    pointer-events: auto; 
    transform: translateX(0); 
}
.tile-info-header { 
    display: flex; 
    align-items: center; 
    gap: 12px; 
    margin-bottom: 12px; 
    padding-bottom: 12px; 
    border-bottom: 1px solid var(--border-subtle); 
}
.tile-info-dot { 
    width: 20px; 
    height: 20px; 
    border-radius: 6px;
    flex-shrink: 0;
}
.tile-info-header strong { 
    font-size: 14px; 
    font-weight: 600; 
    color: var(--text-primary); 
}
.tile-info p { 
    font-size: 13px; 
    color: var(--text-secondary); 
    line-height: 1.5; 
    margin: 0 0 12px; 
}
.tile-info small { 
    font-size: 11px; 
    color: var(--text-tertiary);
    font-weight: 500;
}

/* ═══════════ MAIN GRID ═══════════ */
.main { 
    flex: 1; 
    overflow: auto; 
    padding: 20px;
    background: var(--bg);
}

.grid { 
    background: var(--surface); 
    border-radius: 12px; 
    border: 1px solid var(--border); 
    overflow: hidden; 
    min-height: 100%;
    box-shadow: var(--shadow-sm);
}

.calendar { 
    display: grid; 
    grid-template-columns: 72px repeat(var(--cols), minmax(160px, 1fr)); 
}

.cal-corner { 
    background: var(--bg); 
    border-bottom: 1px solid var(--border); 
    border-right: 1px solid var(--border); 
    position: sticky; 
    left: 0; 
    top: 0;
    z-index: 50;
    width: 72px;
}

.cal-head {
    position: sticky;
    top: 0;
    z-index: 40;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    border-right: 1px solid var(--border-subtle);
    padding: 16px 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    letter-spacing: -0.01em;
}
.cal-head-dot { 
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--c);
    flex-shrink: 0;
}

/* TIME AXIS */
.cal-times {
    position: sticky;
    left: 0;
    z-index: 30;
    background: var(--bg);
    border-right: 1px solid var(--border);
    width: 72px;
    min-width: 72px;
}
.cal-time {
    position: absolute;
    left: 0;
    right: 12px;
    transform: translateY(-50%);
    font-size: 11px;
    font-weight: 600;
    color: var(--text-tertiary);
    white-space: nowrap;
    text-align: right;
    letter-spacing: 0.02em;
}

.cal-col {
    position: relative;
    background: var(--surface);
    border-right: 1px solid var(--border-subtle);
    transition: background 0.15s ease;
}
.cal-col:last-child { border-right: none; }
.cal-col.over { background: var(--accent-light); }

.cal-line { 
    position: absolute; 
    left: 0; 
    right: 0; 
    border-top: 1px solid var(--border-subtle); 
    pointer-events: none; 
}

/* INACTIVE ZONES */
.cal-off { 
    position: absolute; 
    left: 0; 
    right: 0; 
    top: 0; 
    background: var(--bg);
    background-image: repeating-linear-gradient(
        -45deg,
        transparent,
        transparent 4px,
        var(--border-subtle) 4px,
        var(--border-subtle) 5px
    );
    pointer-events: none;
    border-bottom: 1px solid var(--border);
}
.cal-off-b { 
    top: auto; 
    bottom: 0; 
    border-bottom: none;
    border-top: 1px solid var(--border);
}

/* ═══════════ EVENTS — Premium Event Cards ═══════════ */
.ev {
    position: absolute;
    left: 4px;
    right: 4px;
    min-height: 24px;
    border-radius: 6px;
    background: var(--bg);
    border: 1px solid var(--c);
    cursor: pointer;
    z-index: 10;
    display: flex;
    flex-direction: column;
    transition: all 0.15s ease;
    overflow: hidden;
    box-sizing: border-box;
}
.ev:hover {
    z-index: 20;
    box-shadow: var(--shadow-md);
    transform: translateY(-1px);
}
.ev.sel {
    box-shadow: 0 0 0 2px var(--accent), var(--shadow-md);
    z-index: 30;
}
.ev.moving { opacity: 0.6; }
.ev.resizing { z-index: 40; }

.ev-body { 
    flex: 1;
    padding: 4px 8px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-height: 0;
}
.ev-name { 
    font-size: 11px; 
    font-weight: 600; 
    color: var(--text-primary); 
    line-height: 1.3; 
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.ev-time { 
    font-size: 10px; 
    font-weight: 500; 
    color: var(--text-secondary);
    margin-top: 2px;
}

/* Small events */
.ev-sm { padding: 2px 6px; min-height: 20px; }
.ev-sm .ev-body { flex-direction: row; align-items: center; gap: 6px; padding: 0; }
.ev-sm .ev-name { font-size: 10px; }

/* Tooltip for small events */
.ev-sm::after {
    content: attr(data-time);
    position: absolute;
    bottom: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    background: var(--text-primary);
    color: white;
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 500;
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    transition: all 0.15s ease;
    box-shadow: var(--shadow-lg);
}
.ev-sm:hover::after { opacity: 1; }

/* Resize handles */
.ev-handle {
    position: absolute;
    left: 0;
    right: 0;
    height: 8px;
    cursor: ns-resize;
    background: transparent;
    transition: background 0.15s ease;
    z-index: 5;
}
.ev-handle-t { top: 0; border-radius: 6px 6px 0 0; }
.ev-handle-b { bottom: 0; border-radius: 0 0 6px 6px; }
.ev-handle:hover { background: rgba(79, 70, 229, 0.1); }
.ev.resizing .ev-handle { background: rgba(79, 70, 229, 0.15); }

/* ═══════════ MODAL — Premium Dialog ═══════════ */
.modal-wrap {
    position: fixed;
    inset: 0;
    background: rgba(15, 20, 25, 0.5);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    animation: modalFadeIn 0.2s ease;
}

@keyframes modalFadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
}

.modal {
    background: var(--surface);
    border-radius: 16px;
    width: 420px;
    max-width: calc(100vw - 48px);
    max-height: calc(100vh - 48px);
    overflow: hidden;
    box-shadow: var(--shadow-xl);
    animation: modalSlideIn 0.25s ease;
}

@keyframes modalSlideIn {
    from { transform: translateY(16px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
}

.modal-head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 20px 24px;
    border-bottom: 1px solid var(--border);
}
.modal-icon {
    width: 36px;
    height: 36px;
    border-radius: 10px;
    background: linear-gradient(135deg, var(--c), color-mix(in srgb, var(--c) 80%, black));
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 15px;
    font-weight: 700;
    box-shadow: var(--shadow-sm);
}
.modal-head h2 { 
    margin: 0; 
    font-size: 16px; 
    font-weight: 600; 
    color: var(--text-primary); 
    flex: 1;
    letter-spacing: -0.01em;
}
.modal-x { 
    width: 32px; 
    height: 32px; 
    background: transparent;
    border: none; 
    border-radius: 8px; 
    cursor: pointer; 
    font-size: 20px; 
    color: var(--text-tertiary); 
    transition: all 0.15s ease; 
    display: flex; 
    align-items: center; 
    justify-content: center; 
}
.modal-x:hover { 
    background: var(--bg); 
    color: var(--text-secondary); 
}

.modal-body { padding: 24px; }

.modal-foot { 
    display: flex; 
    gap: 10px; 
    padding: 16px 24px; 
    background: var(--bg); 
    border-top: 1px solid var(--border); 
}
.modal-foot .btn { 
    flex: 1; 
    padding: 12px 20px; 
    font-size: 14px; 
}

/* ═══════════ FORM — Refined Inputs ═══════════ */
.mf { margin-bottom: 20px; }
.mf:last-child { margin-bottom: 0; }
.mf label { 
    display: block; 
    font-size: 12px; 
    font-weight: 600; 
    color: var(--text-secondary); 
    margin-bottom: 8px; 
    letter-spacing: 0.02em;
}
.mf input:not([type="checkbox"]), .mf select { 
    width: 100%; 
    height: 42px; 
    font-size: 14px; 
    background: var(--surface); 
    border: 1px solid var(--border);
    border-radius: 8px; 
    padding: 0 14px;
    color: var(--text-primary);
    font-family: inherit;
    transition: all 0.15s ease;
}
.mf input:focus, .mf select:focus { 
    border-color: var(--accent); 
    box-shadow: var(--shadow-focus); 
    outline: none; 
}
.mf-row { display: flex; gap: 16px; }
.mf-row .mf { flex: 1; }

.time-row { display: flex; align-items: center; gap: 12px; }
.time-box { 
    display: flex; 
    align-items: center; 
    background: var(--surface); 
    border: 1px solid var(--border); 
    border-radius: 8px; 
    overflow: hidden;
    transition: all 0.15s ease;
}
.time-box:focus-within { 
    border-color: var(--accent); 
    box-shadow: var(--shadow-focus); 
}
.time-box input { 
    width: 80px !important; 
    height: 42px !important; 
    border: none !important; 
    background: none !important; 
    text-align: center; 
    font-weight: 600; 
    font-size: 14px !important; 
    padding: 0 !important; 
    color: var(--text-primary); 
}
.time-box button { 
    width: 36px; 
    height: 42px; 
    border: none; 
    background: var(--bg); 
    cursor: pointer; 
    font-size: 16px; 
    color: var(--text-tertiary); 
    transition: all 0.15s ease; 
    display: flex;
    align-items: center;
    justify-content: center;
}
.time-box button:hover { 
    background: var(--border-subtle); 
    color: var(--text-primary); 
}
.time-box button:first-child { border-right: 1px solid var(--border-subtle); }
.time-box button:last-child { border-left: 1px solid var(--border-subtle); }
.time-row > span { 
    color: var(--text-tertiary); 
    font-size: 13px; 
    font-weight: 500; 
}

.dur-row { 
    display: flex; 
    flex-wrap: wrap; 
    gap: 8px; 
    margin-top: 12px; 
}
.dur-row button { 
    padding: 8px 14px; 
    font: inherit; 
    font-size: 12px; 
    font-weight: 600; 
    background: var(--bg); 
    border: 1px solid var(--border); 
    border-radius: 6px; 
    cursor: pointer; 
    color: var(--text-secondary); 
    transition: all 0.15s ease; 
}
.dur-row button:hover { 
    border-color: var(--accent); 
    color: var(--accent); 
    background: var(--accent-subtle); 
}

.checks { 
    display: grid; 
    grid-template-columns: repeat(2, 1fr); 
    gap: 6px; 
    max-height: 140px; 
    overflow-y: auto; 
    padding: 12px; 
    background: var(--bg); 
    border-radius: 8px; 
    border: 1px solid var(--border); 
}
.checks label { 
    display: flex; 
    align-items: center; 
    gap: 10px; 
    padding: 10px 12px; 
    background: var(--surface); 
    border-radius: 6px; 
    cursor: pointer; 
    font-size: 13px; 
    font-weight: 500; 
    color: var(--text-secondary);
    transition: all 0.15s ease;
    border: 1px solid transparent;
}
.checks label:hover { 
    background: var(--accent-subtle);
    border-color: var(--accent-light);
}
.checks input { 
    width: 16px; 
    height: 16px; 
    margin: 0; 
    accent-color: var(--accent);
    cursor: pointer;
}

/* ═══════════ NOTIFICATIONS — Premium Toast ═══════════ */
#notify { 
    position: fixed; 
    bottom: 28px; 
    left: 50%; 
    transform: translateX(-50%) translateY(8px); 
    background: var(--text-primary); 
    color: white; 
    padding: 14px 28px; 
    border-radius: 12px; 
    font-size: 14px; 
    font-weight: 600; 
    opacity: 0; 
    box-shadow: var(--shadow-xl); 
    transition: all 0.25s ease; 
    z-index: 1001;
    letter-spacing: -0.01em;
}
#notify.on { 
    opacity: 1; 
    transform: translateX(-50%) translateY(0); 
}

/* ═══════════ RESPONSIVE ═══════════ */
@media (max-width: 1100px) {
    .top { 
        flex-wrap: wrap; 
        height: auto; 
        padding: 16px 20px; 
        gap: 12px; 
    }
    .top-right { 
        flex-wrap: wrap; 
        gap: 10px; 
    }
    .tool-group { 
        flex-wrap: wrap;
        padding-left: 0;
        border-left: none;
    }
    .side { width: 200px; }
    .blocks { grid-template-columns: 1fr; }
}

@media (max-width: 768px) {
    .body { flex-direction: column; }
    .side { 
        width: 100%; 
        max-height: 200px;
        border-right: none;
        border-bottom: 1px solid var(--border);
    }
    .blocks { 
        grid-template-columns: repeat(4, 1fr);
    }
    .main { padding: 12px; }
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
