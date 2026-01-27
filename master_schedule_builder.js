// =================================================================
// SCHEDULE BUILDER v9.1 — PREMIUM ENTERPRISE DESIGN
// =================================================================
// Updated CSS for professional, sleek appearance
// All functionality preserved from v9.0
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
    activity:         { name: 'Activity',    color: '#4F46E5', bg: '#E0E7FF', desc: 'General activity slot. The scheduler will assign any available activity.' },
    sports:           { name: 'Sports',      color: '#16A34A', bg: '#DCFCE7', desc: 'Dedicated sports period. Assigns outdoor field activities and team sports.' },
    special:          { name: 'Special',     color: '#0D9488', bg: '#CCFBF1', desc: 'Special activity slot. For unique camp-wide events or guest activities.' },
    smart:            { name: 'Smart',       color: '#7C3AED', bg: '#EDE9FE', dashed: true, desc: 'Smart balanced slot. Automatically balances two activities with a fallback option.' },
    split:            { name: 'Split',       color: '#D97706', bg: '#FEF3C7', desc: 'Split time block. Divides the period into two different activities.' },
    elective:         { name: 'Elective',    color: '#DB2777', bg: '#FCE7F3', desc: 'Elective choice period. Campers choose from a set of available activities.' },
    league:           { name: 'League',      color: '#9333EA', bg: '#F3E8FF', desc: 'League game slot. Scheduled competitive games between bunks or teams.' },
    specialty_league: { name: 'Specialty',   color: '#CA8A04', bg: '#FEF9C3', desc: 'Specialty league. Tournament or bracket-style competition events.' },
    swim:             { name: 'Swim',        color: '#0284C7', bg: '#E0F2FE', desc: 'Swimming period. Pool or lake activities with lifeguard supervision.' },
    lunch:            { name: 'Lunch',       color: '#DC2626', bg: '#FEE2E2', desc: 'Lunch break. Meal time - no activities scheduled.' },
    snacks:           { name: 'Snacks',      color: '#EA580C', bg: '#FFEDD5', desc: 'Snack time. Short break for refreshments between activities.' },
    dismissal:        { name: 'Dismissal',   color: '#E11D48', bg: '#FCE7F3', desc: 'End of day dismissal. Wrap-up and departure time.' },
    custom:           { name: 'Custom',      color: '#475569', bg: '#F1F5F9', desc: 'Custom event. Define your own activity with optional location reservations.' }
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
    let eM = existing ? toM(existing.endTime) : sM + 40;
    
    const wrap = document.createElement('div'); wrap.className = 'modal-wrap'; wrap.id = 'modal-wrap';
    const box = document.createElement('div'); box.className = 'modal';
    
    const renderBody = () => {
        let extra = '';
        if (type === 'smart') {
            const a1 = existing?.smartActivities?.[0] || '', a2 = existing?.smartActivities?.[1] || '', fb = existing?.smartActivities?.[2] || '';
            extra = `<div class="mf"><label>Primary Activity</label><input id="f-a1" value="${h(a1)}" placeholder="e.g., Basketball"></div><div class="mf"><label>Secondary Activity</label><input id="f-a2" value="${h(a2)}" placeholder="e.g., Soccer"></div><div class="mf"><label>Fallback (optional)</label><input id="f-fb" value="${h(fb)}" placeholder="e.g., Indoor Games"></div>`;
        } else if (type === 'split') {
            const s1 = existing?.subEvents?.[0]?.activity || '', s2 = existing?.subEvents?.[1]?.activity || '';
            extra = `<div class="mf"><label>First Half</label><input id="f-s1" value="${h(s1)}" placeholder="Activity 1"></div><div class="mf"><label>Second Half</label><input id="f-s2" value="${h(s2)}" placeholder="Activity 2"></div>`;
        } else if (type === 'elective') {
            const sp = window.loadGlobalSettings?.()?.sports || [], sel = existing?.electiveActivities || [];
            extra = `<div class="mf"><label>Available Activities</label><div class="checks">${sp.length ? sp.map(s => `<label><input type="checkbox" name="el" value="${h(s)}" ${sel.includes(s) ? 'checked' : ''}><span>${h(s)}</span></label>`).join('') : '<span style="color:#94a3b8;font-size:12px;">No sports configured</span>'}</div></div>`;
        } else if (type === 'custom') {
            const loc = existing?.location || '';
            const allLocs = locs();
            extra = `<div class="mf"><label>Reserve Location (optional)</label><select id="f-loc"><option value="">None</option>${allLocs.map(l => `<option value="${h(l.n)}" ${loc === l.n ? 'selected' : ''}>${h(l.n)} (${l.t})</option>`).join('')}</select></div>`;
        }
        
        return `
            <div class="modal-head">
                <span class="modal-icon" style="--c:${B.color}">${B.name[0]}</span>
                <h2>${existing ? 'Edit' : 'Add'} ${B.name}</h2>
                <button class="modal-x" id="modal-close">×</button>
            </div>
            <div class="modal-body">
                <div class="mf"><label>Event Name</label><input id="f-name" value="${h(existing?.event || '')}" placeholder="${B.name}"></div>
                <div class="mf-row">
                    <div class="mf"><label>Start</label><div class="time-box"><button data-d="-5" data-t="s">−</button><input id="f-start" value="${toS(sM)}" readonly><button data-d="5" data-t="s">+</button></div></div>
                    <div class="mf"><label>End</label><div class="time-box"><button data-d="-5" data-t="e">−</button><input id="f-end" value="${toS(eM)}" readonly><button data-d="5" data-t="e">+</button></div></div>
                </div>
                <div class="dur-row"><button data-m="20">20m</button><button data-m="30">30m</button><button data-m="40">40m</button><button data-m="45">45m</button><button data-m="60">1h</button><button data-m="90">1.5h</button></div>
                ${extra}
            </div>
            <div class="modal-foot">
                <button class="btn btn-ghost" id="modal-cancel">Cancel</button>
                <button class="btn btn-primary" id="modal-save">${existing ? 'Update' : 'Add'}</button>
            </div>
        `;
    };
    
    box.innerHTML = renderBody();
    wrap.appendChild(box);
    document.body.appendChild(wrap);
    
    // Time buttons
    box.querySelectorAll('.time-box button').forEach(btn => {
        btn.onclick = () => {
            const d = parseInt(btn.dataset.d), t = btn.dataset.t;
            if (t === 's') { sM = Math.max(0, sM + d); if (sM >= eM) eM = sM + 5; }
            else { eM = Math.max(sM + 5, eM + d); }
            document.getElementById('f-start').value = toS(sM);
            document.getElementById('f-end').value = toS(eM);
        };
    });
    
    // Duration buttons
    box.querySelectorAll('.dur-row button').forEach(btn => {
        btn.onclick = () => { eM = sM + parseInt(btn.dataset.m); document.getElementById('f-end').value = toS(eM); };
    });
    
    // Close
    const close = () => wrap.remove();
    wrap.onclick = e => { if (e.target === wrap) close(); };
    document.getElementById('modal-close').onclick = close;
    document.getElementById('modal-cancel').onclick = close;
    
    // Save
    document.getElementById('modal-save').onclick = () => {
        const name = document.getElementById('f-name').value.trim() || B.name;
        if (sM >= eM) return alert('End must be after start');
        
        const ev = existing ? { ...existing } : { id: id(), type, division: div };
        ev.event = name;
        ev.startTime = toS(sM);
        ev.endTime = toS(eM);
        
        if (type === 'smart') {
            const a1 = document.getElementById('f-a1')?.value.trim();
            const a2 = document.getElementById('f-a2')?.value.trim();
            const fb = document.getElementById('f-fb')?.value.trim();
            if (!a1 || !a2) return alert('Fill primary and secondary');
            ev.smartActivities = fb ? [a1, a2, fb] : [a1, a2];
        } else if (type === 'split') {
            const s1 = document.getElementById('f-s1')?.value.trim();
            const s2 = document.getElementById('f-s2')?.value.trim();
            if (!s1 || !s2) return alert('Fill both halves');
            const mid = sM + Math.floor((eM - sM) / 2);
            ev.subEvents = [{ activity: s1, startTime: toS(sM), endTime: toS(mid) }, { activity: s2, startTime: toS(mid), endTime: toS(eM) }];
        } else if (type === 'elective') {
            const acts = [...box.querySelectorAll('input[name="el"]:checked')].map(c => c.value);
            if (acts.length < 2) return alert('Select at least 2');
            ev.electiveActivities = acts;
        } else if (type === 'custom') {
            const loc = document.getElementById('f-loc')?.value;
            if (loc) ev.location = loc; else delete ev.location;
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
    
    setTimeout(() => document.getElementById('f-name')?.focus(), 50);
};

// Draw
const draw = () => {
    const g = document.getElementById('grid'); if (!g) return;
    const D = window.divisions || {}, cols = Object.keys(D).filter(d => D[d]?.bunks?.length);
    
    if (!cols.length) {
        g.innerHTML = `<div class="empty"><svg width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg><p>No divisions configured</p><small>Add divisions in Setup to begin</small></div>`;
        return;
    }
    
    const { lo, hi } = bounds(), ht = (hi - lo) * PX;
    let html = `<div class="calendar" style="--cols:${cols.length}"><div class="cal-corner"></div>`;
    
    // Headers
    cols.forEach(c => {
        const clr = D[c]?.color || '#64748b';
        html += `<div class="cal-head"><span class="cal-head-dot" style="background:${clr}"></span><span>${h(c)}</span></div>`;
    });
    
    // Time rail
    html += `<div class="cal-times" style="height:${ht}px">`;
    for (let m = lo; m < hi; m += 60) {
        html += `<div class="cal-time" style="top:${(m - lo) * PX}px">${toS(m)}</div>`;
    }
    html += `</div>`;
    
    // Columns
    cols.forEach(c => {
        const dv = D[c], ds = toM(dv?.startTime), de = toM(dv?.endTime);
        html += `<div class="cal-col" data-d="${h(c)}" style="height:${ht}px">`;
        
        // Grid lines
        for (let m = lo; m < hi; m += 60) {
            html += `<div class="cal-line" style="top:${(m - lo) * PX}px"></div>`;
        }
        
        // Inactive zones
        if (ds != null && ds > lo) html += `<div class="cal-off" style="height:${(ds - lo) * PX}px"></div>`;
        if (de != null && de < hi) html += `<div class="cal-off cal-off-b" style="height:${(hi - de) * PX}px"></div>`;
        
        // Events
        skeleton.filter(e => e.division === c).forEach(ev => {
            const s = toM(ev.startTime), e = toM(ev.endTime);
            if (s != null && e != null && e > s) {
                const top = (s - lo) * PX, height = (e - s) * PX - 1;
                const B = BLOCKS[ev.type] || BLOCKS.custom;
                const small = height < 36;
                html += `<div class="ev ${small ? 'ev-sm' : ''}" data-id="${ev.id}" draggable="true" style="top:${top}px;height:${Math.max(height, 24)}px;--c:${B.color};--bg:${B.bg};${B.dashed ? 'border-style:dashed;' : ''}"><div class="ev-body"><span class="ev-name">${h(ev.event || B.name)}</span>${small ? '' : `<span class="ev-time">${toS(s)} – ${toS(e)}</span>`}</div><div class="ev-handle ev-handle-t"></div><div class="ev-handle ev-handle-b"></div></div>`;
            }
        });
        
        html += `</div>`;
    });
    
    html += `</div>`;
    g.innerHTML = html;
    bindGrid();
};

// Bind UI
const bindUI = () => {
    document.getElementById('btn-load')?.addEventListener('click', () => { const n = document.getElementById('tpl-sel').value; if (!n) return notify('Select a template'); if (skeleton.length && !confirm('Replace current schedule?')) return; loadT(n); });
    document.getElementById('btn-save')?.addEventListener('click', () => { const n = document.getElementById('save-name').value.trim(); if (!n) return notify('Enter a name'); const all = window.getSavedSkeletons?.() || {}; if (all[n] && !confirm(`Replace "${n}"?`)) return; saveT(n, !!all[n]); document.getElementById('save-name').value = ''; });
    document.getElementById('btn-update')?.addEventListener('click', () => template && saveT(template, true));
    document.getElementById('btn-clear')?.addEventListener('click', () => { if (skeleton.length && !confirm('Clear entire schedule?')) return; skeleton = []; template = null; clear(); draw(); sync(); });
    document.getElementById('btn-del')?.addEventListener('click', () => { const n = document.getElementById('del-sel').value; if (!n || !confirm(`Delete "${n}"?`)) return; delT(n); });
    
    // Tile drag and click for info
    document.querySelectorAll('.block').forEach(b => {
        b.addEventListener('dragstart', e => { e.dataTransfer.setData('type', b.dataset.type); b.classList.add('dragging'); });
        b.addEventListener('dragend', () => b.classList.remove('dragging'));
        b.addEventListener('click', e => {
            if (e.detail === 1) {
                const info = document.getElementById('tile-info');
                const rect = b.getBoundingClientRect();
                const type = b.dataset.type;
                const B = BLOCKS[type];
                info.innerHTML = `<div class="tile-info-header"><span class="tile-info-dot" style="background:${B.color}"></span><strong>${B.name}</strong></div><p>${B.desc}</p><small>Drag to add to schedule</small>`;
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
            if (mv) {
                const ev = skeleton.find(x => x.id === mv);
                if (ev) {
                    const rect = col.getBoundingClientRect();
                    const y = e.clientY - rect.top;
                    const m = lo + Math.round(y / PX / SNAP) * SNAP;
                    const dur = toM(ev.endTime) - toM(ev.startTime);
                    ev.division = col.dataset.d;
                    ev.startTime = toS(m);
                    ev.endTime = toS(m + dur);
                    save(); draw();
                }
            } else {
                const type = e.dataTransfer.getData('type');
                if (type) {
                    const rect = col.getBoundingClientRect();
                    const y = e.clientY - rect.top;
                    const m = lo + Math.round(y / PX / SNAP) * SNAP;
                    modal(type, col.dataset.d, m);
                }
            }
        });
    });
    
    document.querySelectorAll('.ev').forEach(tile => {
        const ev = skeleton.find(x => x.id === tile.dataset.id);
        tile.addEventListener('click', e => {
            if (!e.target.classList.contains('ev-handle')) {
                document.querySelectorAll('.ev.sel').forEach(t => t.classList.remove('sel'));
                tile.classList.add('sel');
            }
        });
        tile.addEventListener('dblclick', () => { if (ev) modal(ev.type, ev.division, null, ev); });
        tile.addEventListener('contextmenu', e => { e.preventDefault(); if (ev && confirm('Delete this block?')) { skeleton = skeleton.filter(x => x.id !== ev.id); save(); draw(); } });
        tile.addEventListener('dragstart', e => { if (e.target.classList.contains('ev-handle')) { e.preventDefault(); return; } e.dataTransfer.setData('move', ev?.id || ''); tile.classList.add('moving'); });
        tile.addEventListener('dragend', () => tile.classList.remove('moving'));
        
        // Resize handles
        tile.querySelectorAll('.ev-handle').forEach(hndl => {
            const isTop = hndl.classList.contains('ev-handle-t');
            let y0, t0, h0;
            const move = e => {
                const d = e.clientY - y0;
                if (isTop) {
                    const nt = Math.round((t0 + d) / (SNAP * PX)) * (SNAP * PX);
                    const nh = h0 - (nt - t0);
                    if (nh >= 24) { tile.style.top = nt + 'px'; tile.style.height = nh + 'px'; }
                } else {
                    const nh = Math.max(24, Math.round((h0 + d) / (SNAP * PX)) * (SNAP * PX));
                    tile.style.height = nh + 'px';
                }
            };
            const up = () => {
                document.removeEventListener('mousemove', move);
                document.removeEventListener('mouseup', up);
                tile.classList.remove('resizing');
                if (ev) {
                    const nt = parseFloat(tile.style.top);
                    const nh = parseFloat(tile.style.height);
                    ev.startTime = toS(lo + nt / PX);
                    ev.endTime = toS(lo + (nt + nh) / PX);
                    save(); draw();
                }
            };
            hndl.addEventListener('mousedown', e => {
                e.preventDefault(); e.stopPropagation();
                y0 = e.clientY;
                t0 = parseFloat(tile.style.top);
                h0 = parseFloat(tile.style.height);
                tile.classList.add('resizing');
                document.addEventListener('mousemove', move);
                document.addEventListener('mouseup', up);
            });
        });
    });
    
    document.getElementById('grid')?.addEventListener('click', e => {
        if (!e.target.closest('.ev')) document.querySelectorAll('.ev.sel').forEach(t => t.classList.remove('sel'));
    });
};

// Render
const render = () => {
    if (!container) return;
    container.innerHTML = `
        <div class="sch">
            ${css()}
            <div class="top">
                <div class="top-left">
                    <h1>Schedule Builder</h1>
                    <span id="status-badge" class="badge"></span>
                    <span id="status-name" class="status-name">New</span>
                </div>
                <div class="top-right">
                    <div class="tool-group">
                        <select id="tpl-sel"></select>
                        <button class="btn btn-ghost" id="btn-load">Load</button>
                        <button class="btn btn-ghost" id="btn-update" style="display:none">Update</button>
                    </div>
                    <div class="tool-group">
                        <input id="save-name" placeholder="Template name...">
                        <button class="btn btn-primary" id="btn-save">Save</button>
                    </div>
                    <div class="tool-group">
                        <select id="del-sel"></select>
                        <button class="btn btn-danger" id="btn-del">Delete</button>
                        <button class="btn btn-ghost" id="btn-clear">Clear</button>
                    </div>
                </div>
            </div>
            <div class="body">
                <div class="side">
                    <div class="side-head">
                        <span>Block Types</span>
                        <span class="side-hint">Drag to calendar</span>
                    </div>
                    <div class="blocks">
                        ${Object.entries(BLOCKS).map(([k, v]) => `
                            <div class="block" draggable="true" data-type="${k}">
                                <span class="block-dot" style="--c:${v.color};--bg:${v.bg}">${v.name[0]}</span>
                                <span>${v.name}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
                <div class="main">
                    <div id="grid" class="grid"></div>
                </div>
            </div>
            <div id="tile-info" class="tile-info"></div>
        </div>
    `;
    bindUI();
    fills();
    draw();
    sync();
};

// ═══════════════════════════════════════════════════════════════════════════════
// GOOGLE SHEETS STYLE — CLEAN, MINIMAL, SPREADSHEET-LIKE
// ═══════════════════════════════════════════════════════════════════════════════

const css = () => `<style>
@import url('https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;600&family=Roboto:wght@400;500&display=swap');

.sch {
    --bg: #f8f9fa;
    --surface: #ffffff;
    --border: #dadce0;
    --border-light: #e8eaed;
    --border-dark: #c0c0c0;
    --text: #202124;
    --text-secondary: #5f6368;
    --text-muted: #80868b;
    --accent: #1a73e8;
    --accent-hover: #1557b0;
    --accent-light: #e8f0fe;
    --green: #1e8e3e;
    --green-light: #e6f4ea;
    --yellow: #f9ab00;
    --yellow-light: #fef7e0;
    --red: #d93025;
    --red-light: #fce8e6;
    
    font-family: 'Google Sans', 'Roboto', -apple-system, BlinkMacSystemFont, sans-serif;
    background: var(--surface);
    color: var(--text);
    height: 100%;
    display: flex;
    flex-direction: column;
    font-size: 13px;
    -webkit-font-smoothing: antialiased;
}

/* Google-style scrollbar */
.sch ::-webkit-scrollbar { width: 12px; height: 12px; }
.sch ::-webkit-scrollbar-track { background: var(--bg); }
.sch ::-webkit-scrollbar-thumb { background: #dadce0; border: 3px solid var(--bg); border-radius: 10px; }
.sch ::-webkit-scrollbar-thumb:hover { background: #bdc1c6; }
.sch ::-webkit-scrollbar-corner { background: var(--bg); }

/* ═══════════ TOOLBAR (Google Sheets style) ═══════════ */
.top {
    display: flex;
    align-items: center;
    padding: 0 8px;
    height: 40px;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    gap: 4px;
}
.top-left { 
    display: flex; 
    align-items: center; 
    gap: 12px;
    padding-right: 16px;
    border-right: 1px solid var(--border);
    margin-right: 8px;
}
.top h1 { 
    font-size: 14px; 
    font-weight: 500; 
    margin: 0; 
    color: var(--text);
}
.top-right { 
    display: flex; 
    align-items: center; 
    gap: 2px;
    flex: 1;
}

.badge {
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
    margin-left: 8px;
}
.badge:empty { display: none; }
.badge.draft { background: var(--yellow-light); color: #ea8600; }
.badge.saved { background: var(--green-light); color: var(--green); }

.status-name { 
    font-size: 12px; 
    color: var(--text-secondary); 
    font-weight: 400;
    margin-left: 4px;
}

.tool-group {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 4px;
}
.tool-group::after {
    content: '';
    width: 1px;
    height: 20px;
    background: var(--border);
    margin-left: 6px;
}
.tool-group:last-child::after { display: none; }

/* ═══════════ CONTROLS (Google style) ═══════════ */
select, input[type="text"], .top input {
    background: var(--surface);
    border: 1px solid var(--border);
    font-family: inherit;
    font-size: 13px;
    font-weight: 400;
    padding: 4px 8px;
    border-radius: 4px;
    color: var(--text);
    outline: none;
    transition: border-color 0.1s, box-shadow 0.1s;
    height: 28px;
    min-width: 120px;
}
select:hover, input:hover { border-color: var(--border-dark); }
select:focus, input:focus { 
    border-color: var(--accent); 
    box-shadow: 0 0 0 2px var(--accent-light); 
}
select {
    cursor: pointer;
    padding-right: 24px;
    background-image: url("data:image/svg+xml,%3Csvg width='10' height='10' viewBox='0 0 10 10' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M2 3.5L5 6.5L8 3.5' stroke='%235f6368' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 6px center;
    appearance: none;
}

.btn {
    padding: 0 12px;
    height: 28px;
    border-radius: 4px;
    font-family: inherit;
    font-weight: 500;
    font-size: 13px;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    transition: background 0.1s;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    white-space: nowrap;
}
.btn:hover { background: var(--border-light); }
.btn:active { background: var(--border); }

.btn-primary { 
    background: var(--accent); 
    color: white;
}
.btn-primary:hover { background: var(--accent-hover); }

.btn-ghost { background: transparent; }
.btn-ghost:hover { background: var(--border-light); }

.btn-danger { color: var(--red); }
.btn-danger:hover { background: var(--red-light); }

/* ═══════════ LAYOUT ═══════════ */
.body { display: flex; flex: 1; overflow: hidden; }

/* ═══════════ SIDEBAR (Cell palette) ═══════════ */
.side {
    width: 180px;
    background: var(--surface);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
}
.side-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
}
.side-head span:first-child {
    font-size: 11px;
    font-weight: 500;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
}
.side-hint { 
    font-size: 10px; 
    color: var(--text-muted); 
}

.blocks {
    flex: 1;
    padding: 8px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.block {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    cursor: grab;
    transition: all 0.1s;
}
.block:hover {
    background: var(--accent-light);
    border-color: var(--accent);
}
.block:active { cursor: grabbing; }
.block.dragging { opacity: 0.4; }

.block-dot {
    width: 24px;
    height: 24px;
    border-radius: 4px;
    background: var(--bg);
    border: 2px solid var(--c);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--c);
    font-weight: 600;
    font-size: 11px;
    flex-shrink: 0;
}
.block span:last-child {
    font-size: 12px;
    font-weight: 400;
    color: var(--text);
}

/* ═══════════ EMPTY STATE ═══════════ */
.empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 40px;
    color: var(--text-muted);
    text-align: center;
}
.empty svg { margin-bottom: 12px; opacity: 0.3; }
.empty p { font-size: 14px; color: var(--text-secondary); margin: 0 0 4px; }
.empty small { font-size: 12px; color: var(--text-muted); }

/* ═══════════ TILE INFO ═══════════ */
.tile-info {
    position: fixed;
    z-index: 9000;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
    width: 220px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.15);
    opacity: 0;
    pointer-events: none;
    transform: translateY(-4px);
    transition: all 0.15s;
}
.tile-info.show { opacity: 1; pointer-events: auto; transform: translateY(0); }
.tile-info-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
}
.tile-info-dot { width: 16px; height: 16px; border-radius: 3px; }
.tile-info-header strong { font-size: 13px; font-weight: 500; }
.tile-info p { font-size: 12px; color: var(--text-secondary); line-height: 1.4; margin: 0 0 8px; }
.tile-info small { font-size: 11px; color: var(--text-muted); }

/* ═══════════ MAIN GRID (Spreadsheet style) ═══════════ */
.main { 
    flex: 1; 
    overflow: auto; 
    background: var(--bg);
}
.grid {
    background: var(--surface);
    min-height: 100%;
}

.calendar { 
    display: grid; 
    grid-template-columns: 60px repeat(var(--cols), minmax(120px, 1fr));
    border-left: 1px solid var(--border);
}

/* Column/Row headers - Google Sheets style */
.cal-corner {
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    border-right: 1px solid var(--border);
    position: sticky;
    left: 0;
    top: 0;
    z-index: 50;
}
.cal-head {
    position: sticky;
    top: 0;
    z-index: 40;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    border-right: 1px solid var(--border);
    padding: 0 8px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
}
.cal-head-dot { width: 8px; height: 8px; border-radius: 2px; }

/* Time column - like row numbers */
.cal-times {
    position: sticky;
    left: 0;
    z-index: 30;
    background: var(--bg);
    border-right: 1px solid var(--border);
    width: 60px;
}
.cal-time {
    position: absolute;
    left: 0;
    right: 0;
    transform: translateY(-50%);
    font-size: 10px;
    font-weight: 400;
    color: var(--text-secondary);
    text-align: center;
    padding: 0 4px;
}

/* Grid cells */
.cal-col {
    position: relative;
    background: var(--surface);
    border-right: 1px solid var(--border);
}
.cal-col:last-child { border-right: 1px solid var(--border); }
.cal-col.over { background: var(--accent-light); }

.cal-line {
    position: absolute;
    left: 0;
    right: 0;
    border-top: 1px solid var(--border-light);
    pointer-events: none;
}

/* Inactive zones */
.cal-off {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    background: repeating-linear-gradient(
        -45deg,
        var(--bg),
        var(--bg) 2px,
        #e8eaed 2px,
        #e8eaed 3px
    );
    pointer-events: none;
}
.cal-off-b { top: auto; bottom: 0; }

/* ═══════════ EVENTS (Cell-like) ═══════════ */
.ev {
    position: absolute;
    left: 2px;
    right: 2px;
    min-height: 20px;
    border-radius: 3px;
    background: var(--bg);
    border-left: 3px solid var(--c);
    cursor: pointer;
    z-index: 10;
    display: flex;
    flex-direction: column;
    transition: box-shadow 0.1s;
    overflow: hidden;
    box-shadow: 0 1px 2px rgba(0,0,0,0.08);
}
.ev:hover { 
    z-index: 20; 
    box-shadow: 0 2px 6px rgba(0,0,0,0.15);
}
.ev.sel { 
    box-shadow: 0 0 0 2px var(--accent);
    z-index: 30; 
}
.ev.moving { opacity: 0.5; }
.ev.resizing { z-index: 40; }

.ev-body {
    flex: 1;
    padding: 3px 6px;
    display: flex;
    flex-direction: column;
    justify-content: center;
}
.ev-name {
    font-size: 11px;
    font-weight: 500;
    color: var(--text);
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.ev-time {
    font-size: 10px;
    font-weight: 400;
    color: var(--text-secondary);
    margin-top: 1px;
}

.ev-sm { min-height: 18px; }
.ev-sm .ev-body { padding: 2px 4px; }
.ev-sm .ev-name { font-size: 10px; }

.ev-handle {
    position: absolute;
    left: 0;
    right: 0;
    height: 6px;
    cursor: ns-resize;
    background: transparent;
    z-index: 5;
}
.ev-handle-t { top: 0; }
.ev-handle-b { bottom: 0; }
.ev-handle:hover { background: rgba(26, 115, 232, 0.15); }

/* ═══════════ MODAL (Google style dialog) ═══════════ */
.modal-wrap {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
}
.modal {
    background: var(--surface);
    border-radius: 8px;
    width: 400px;
    max-width: calc(100vw - 32px);
    max-height: calc(100vh - 32px);
    overflow: hidden;
    box-shadow: 0 8px 32px rgba(0,0,0,0.25);
}
.modal-head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
}
.modal-icon {
    width: 32px;
    height: 32px;
    border-radius: 4px;
    background: var(--c);
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: 600;
}
.modal-head h2 { margin: 0; font-size: 16px; font-weight: 500; flex: 1; color: var(--text); }
.modal-x {
    width: 28px;
    height: 28px;
    background: transparent;
    border: none;
    border-radius: 50%;
    cursor: pointer;
    font-size: 18px;
    color: var(--text-muted);
    transition: background 0.1s;
    display: flex;
    align-items: center;
    justify-content: center;
}
.modal-x:hover { background: var(--border-light); }
.modal-body { padding: 20px; }
.modal-foot {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 20px;
    background: var(--bg);
    border-top: 1px solid var(--border);
}
.modal-foot .btn { padding: 0 20px; height: 32px; }
.modal-foot .btn-primary { 
    background: var(--accent); 
    color: white; 
}

/* ═══════════ FORM ═══════════ */
.mf { margin-bottom: 16px; }
.mf:last-child { margin-bottom: 0; }
.mf label {
    display: block;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
    margin-bottom: 6px;
}
.mf input:not([type="checkbox"]), .mf select {
    width: 100%;
    height: 36px;
    font-size: 13px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0 12px;
    color: var(--text);
    font-family: inherit;
}
.mf input:focus, .mf select:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-light);
    outline: none;
}
.mf-row { display: flex; gap: 12px; }
.mf-row .mf { flex: 1; }

.time-box {
    display: flex;
    align-items: center;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    overflow: hidden;
}
.time-box:focus-within { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-light); }
.time-box input {
    flex: 1;
    height: 36px !important;
    border: none !important;
    background: none !important;
    text-align: center;
    font-weight: 500;
    font-size: 13px !important;
    padding: 0 !important;
}
.time-box button {
    width: 32px;
    height: 36px;
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: 16px;
    color: var(--text-muted);
    transition: background 0.1s;
}
.time-box button:hover { background: var(--border-light); }
.time-box button:first-child { border-right: 1px solid var(--border); }
.time-box button:last-child { border-left: 1px solid var(--border); }

.dur-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.dur-row button {
    padding: 6px 12px;
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    cursor: pointer;
    color: var(--text-secondary);
    transition: all 0.1s;
}
.dur-row button:hover { 
    border-color: var(--accent); 
    color: var(--accent); 
    background: var(--accent-light); 
}

.checks {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 4px;
    max-height: 140px;
    overflow-y: auto;
    padding: 8px;
    background: var(--bg);
    border-radius: 4px;
    border: 1px solid var(--border);
}
.checks label {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px;
    background: var(--surface);
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    color: var(--text);
    transition: background 0.1s;
}
.checks label:hover { background: var(--accent-light); }
.checks input { 
    width: 14px; 
    height: 14px; 
    margin: 0; 
    accent-color: var(--accent); 
}

/* ═══════════ NOTIFY (Google toast) ═══════════ */
#notify {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%) translateY(8px);
    background: #323232;
    color: white;
    padding: 10px 20px;
    border-radius: 4px;
    font-size: 13px;
    font-weight: 400;
    opacity: 0;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    transition: all 0.2s;
    z-index: 9999;
    pointer-events: none;
}
#notify.on { opacity: 1; transform: translateX(-50%) translateY(0); }

/* ═══════════ RESPONSIVE ═══════════ */
@media (max-width: 900px) {
    .top { flex-wrap: wrap; height: auto; padding: 8px; gap: 8px; }
    .top-left { border-right: none; margin-right: 0; padding-right: 0; }
    .tool-group::after { display: none; }
    .side { width: 160px; }
}
</style>`;

// Init
const init = () => {
    container = document.getElementById('master-scheduler-content');
    if (!container) return;
    
    if (!load()) {
        try {
            const a = window.getSkeletonAssignments?.() || {};
            const s = window.getSavedSkeletons?.() || {};
            const dt = window.currentScheduleDate || '';
            const [y, m, d] = dt.split('-').map(Number);
            const dow = y && m && d ? new Date(y, m - 1, d).getDay() : 0;
            const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
            const t = a[days[dow]] || a['Default'];
            skeleton = t && s[t] ? JSON.parse(JSON.stringify(s[t])) : [];
        } catch(e) {
            skeleton = [];
        }
    }
    
    render();
    keys();
    vis();
};

window.initMasterScheduler = init;
window.cleanupMasterScheduler = () => {
    if (_keyHandler) document.removeEventListener('keydown', _keyHandler);
    if (_visHandler) document.removeEventListener('visibilitychange', _visHandler);
    document.getElementById('modal-wrap')?.remove();
    document.getElementById('notify')?.remove();
};
window.refreshMasterSchedulerFromCloud = fills;

})();
