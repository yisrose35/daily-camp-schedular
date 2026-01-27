// =================================================================
// SCHEDULE BUILDER v9.2 — PREMIUM ENTERPRISE DESIGN
// =================================================================
// v9.2 FIXES:
// - Fixed time labels getting cut off at top (added padding)
// - Improved off-hours diagonal stripe pattern (grey, more visible)
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
const PX = 2.9;
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
            const selLocs = existing?.locations || (existing?.location ? [existing.location] : []);
            const allLocs = locs();
            extra = `<div class="mf"><label>Reserve Locations (optional)</label><div class="loc-buttons" id="loc-buttons">${allLocs.length ? allLocs.map(l => `<button type="button" class="loc-btn ${selLocs.includes(l.n) ? 'active' : ''}" data-loc="${h(l.n)}">${h(l.n)}<span class="loc-type">${l.t}</span></button>`).join('') : '<span style="color:#94a3b8;font-size:12px;">No locations configured</span>'}</div></div>`;
        }
        
        // Only show event name field for custom tiles
        const nameField = type === 'custom' 
            ? `<div class="mf"><label>Event Name</label><input id="f-name" value="${h(existing?.event || '')}" placeholder="Custom Event"></div>`
            : `<input type="hidden" id="f-name" value="${h(existing?.event || '')}">`;
        
        return `
            <div class="modal-head">
                <span class="modal-icon" style="--c:${B.color}">${B.name[0]}</span>
                <h2>${existing ? 'Edit' : 'Add'} ${B.name}</h2>
                <button class="modal-x" id="modal-close">×</button>
            </div>
            <div class="modal-body">
                ${nameField}
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
    
    // Location buttons (for custom tiles - multi-select)
    box.querySelectorAll('.loc-btn').forEach(btn => {
        btn.onclick = () => btn.classList.toggle('active');
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
            const selectedLocs = [...box.querySelectorAll('.loc-btn.active')].map(b => b.dataset.loc);
            if (selectedLocs.length > 0) {
                ev.locations = selectedLocs;
                delete ev.location; // Remove old single location field
            } else {
                delete ev.locations;
                delete ev.location;
            }
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
    
    // Time rail (extra height for first label padding)
    html += `<div class="cal-times" style="height:${ht + 14}px">`;
    for (let m = lo; m < hi; m += 60) {
        html += `<div class="cal-time" style="top:${(m - lo) * PX + 14}px">${toS(m)}</div>`;
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
        
        // Inactive zones (grey diagonal stripes for times outside division hours)
        if (ds != null && ds > lo) html += `<div class="cal-off" style="height:${(ds - lo) * PX}px"></div>`;
        if (de != null && de < hi) html += `<div class="cal-off cal-off-b" style="height:${(hi - de) * PX}px"></div>`;
        
        // Events
        skeleton.filter(e => e.division === c).forEach(ev => {
            const s = toM(ev.startTime), e = toM(ev.endTime);
            if (s != null && e != null && e > s) {
                const top = (s - lo) * PX, height = (e - s) * PX - 1;
                const B = BLOCKS[ev.type] || BLOCKS.custom;
                const small = height < 50;
                // Always show time, just formatted differently for small tiles
                html += `<div class="ev ${small ? 'ev-sm' : ''}" data-id="${ev.id}" draggable="true" style="top:${top}px;height:${Math.max(height, 24)}px;--c:${B.color};--bg:${B.bg};${B.dashed ? 'border-style:dashed;' : ''}"><div class="ev-body"><span class="ev-name">${h(ev.event || B.name)}</span><span class="ev-time">${toS(s)} – ${toS(e)}</span></div><div class="ev-handle ev-handle-t"></div><div class="ev-handle ev-handle-b"></div></div>`;
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
// PREMIUM CSS — SLEEK, PROFESSIONAL, ENTERPRISE-GRADE
// ═══════════════════════════════════════════════════════════════════════════════

const css = () => `<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

/* Hide the main page title when Schedule Builder is shown */
#master-scheduler.active ~ .app-page-title,
#master-scheduler.active + .app-page-title,
.tab-content#master-scheduler.active ~ h1.app-page-title {
    display: none !important;
}
/* Also target parent container */
#master-scheduler.active { margin-top: -20px; }

/* Make the tab content fill available space */
#master-scheduler {
    height: calc(100vh - 140px);
    min-height: 500px;
}
#master-scheduler-content {
    height: 100%;
}

.sch {
    --bg: #f8fafc;
    --surface: #ffffff;
    --border: #e2e8f0;
    --border-light: #f1f5f9;
    --border-strong: #cbd5e1;
    --text: #0f172a;
    --text-secondary: #475569;
    --text-muted: #94a3b8;
    --accent: #4f46e5;
    --accent-hover: #4338ca;
    --accent-light: #eef2ff;
    --success: #059669;
    --success-light: #ecfdf5;
    --warning: #d97706;
    --warning-light: #fffbeb;
    --danger: #dc2626;
    --danger-light: #fef2f2;
    --shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
    --shadow-md: 0 4px 6px -1px rgba(0,0,0,0.07), 0 2px 4px -1px rgba(0,0,0,0.04);
    --shadow-lg: 0 10px 15px -3px rgba(0,0,0,0.08), 0 4px 6px -2px rgba(0,0,0,0.04);
    --shadow-xl: 0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.03);
    
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    background: var(--bg);
    color: var(--text);
    height: calc(100vh - 120px);
    min-height: 600px;
    display: flex;
    flex-direction: column;
    -webkit-font-smoothing: antialiased;
    position: relative;
}

.sch ::-webkit-scrollbar { width: 8px; height: 8px; }
.sch ::-webkit-scrollbar-track { background: transparent; }
.sch ::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 4px; }
.sch ::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }

/* ═══════════ TOP BAR ═══════════ */
.top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 22px;
    height: 76px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
}
.top-left { display: flex; align-items: center; gap: 16px; }
.top h1 { font-size: 20px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
.top-right { display: flex; align-items: center; gap: 14px; }

.badge {
    padding: 5px 14px;
    border-radius: 100px;
    font-size: 15px;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    gap: 8px;
}
.badge:empty { display: none; }
.badge::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.badge.draft { background: var(--warning-light); color: var(--warning); }
.badge.saved { background: var(--success-light); color: var(--success); }

.status-name { font-size: 18px; color: var(--text-secondary); font-weight: 500; }

.tool-group {
    display: flex;
    align-items: center;
    gap: 11px;
    padding-left: 16px;
    border-left: 1px solid var(--border-light);
}
.tool-group:first-child { padding-left: 0; border-left: none; }

/* ═══════════ CONTROLS ═══════════ */
select, input[type="text"], .top input {
    background: var(--surface);
    border: 1px solid var(--border);
    font-family: inherit;
    font-size: 18px;
    font-weight: 500;
    padding: 11px 16px;
    border-radius: 11px;
    color: var(--text);
    outline: none;
    transition: all 0.15s;
    min-width: 190px;
}
select:hover, input:hover { border-color: var(--border-strong); }
select:focus, input:focus { border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-light); }
select {
    cursor: pointer;
    padding-right: 43px;
    background-image: url("data:image/svg+xml,%3Csvg width='12' height='12' viewBox='0 0 12 12' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%23475569' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 14px center;
    appearance: none;
}

.btn {
    padding: 11px 22px;
    border-radius: 11px;
    font-family: inherit;
    font-weight: 600;
    font-size: 18px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    transition: all 0.15s;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
}
.btn:hover { background: var(--bg); border-color: var(--border-strong); }
.btn:active { transform: scale(0.98); }
.btn-primary { background: var(--accent); color: white; border-color: var(--accent); }
.btn-primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
.btn-ghost { background: transparent; border-color: transparent; }
.btn-ghost:hover { background: var(--bg); border-color: var(--border); }
.btn-danger { background: var(--danger-light); color: var(--danger); border-color: #fecaca; }
.btn-danger:hover { background: #fee2e2; border-color: #fca5a5; }

/* ═══════════ LAYOUT ═══════════ */
.body { 
    display: flex; 
    flex: 1; 
    overflow: hidden;
    min-height: 0;
}

/* ═══════════ SIDEBAR (PERSISTENT BLOCKS PANEL) ═══════════ */
.side {
    width: 270px;
    background: var(--surface);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    height: 100%;
    overflow: hidden;
}
.side-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 19px 19px 16px;
    border-bottom: 1px solid var(--border-light);
}
.side-head span:first-child {
    font-size: 14px;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
}
.side-hint { font-size: 14px; color: var(--text-muted); }

.blocks {
    flex: 1;
    padding: 16px;
    overflow-y: auto;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 11px;
    align-content: start;
}

.block {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 14px 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 11px;
    cursor: grab;
    transition: all 0.2s;
}
.block:hover {
    border-color: var(--accent);
    background: var(--accent-light);
    box-shadow: var(--shadow-sm);
    transform: translateY(-1px);
}
.block:active { cursor: grabbing; transform: scale(0.97); }
.block.dragging { opacity: 0.5; }

.block-dot {
    width: 38px;
    height: 38px;
    border-radius: 11px;
    border: 2px solid var(--c);
    background: var(--bg);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--c);
    font-weight: 700;
    font-size: 16px;
}
.block span:last-child {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
    text-align: center;
    line-height: 1.2;
}

/* ═══════════ EMPTY STATE ═══════════ */
.empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 65px;
    color: var(--text-muted);
    text-align: center;
}
.empty svg { margin-bottom: 22px; opacity: 0.4; width: 65px; height: 65px; }
.empty p { font-size: 20px; font-weight: 600; color: var(--text-secondary); margin: 0 0 5px; }
.empty small { font-size: 18px; color: var(--text-muted); }

/* ═══════════ TILE INFO ═══════════ */
.tile-info {
    position: fixed;
    z-index: 9000;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 22px;
    width: 350px;
    box-shadow: var(--shadow-xl);
    opacity: 0;
    pointer-events: none;
    transform: translateX(-11px);
    transition: all 0.2s;
}
.tile-info.show { opacity: 1; pointer-events: auto; transform: translateX(0); }
.tile-info-header {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 16px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border-light);
}
.tile-info-dot { width: 27px; height: 27px; border-radius: 8px; }
.tile-info-header strong { font-size: 19px; font-weight: 600; }
.tile-info p { font-size: 18px; color: var(--text-secondary); line-height: 1.5; margin: 0 0 16px; }
.tile-info small { font-size: 15px; color: var(--text-muted); }

/* ═══════════ MAIN GRID ═══════════ */
.main { 
    flex: 1; 
    overflow: auto; 
    padding: 22px; 
    background: var(--bg);
    min-height: 0;
}
.grid {
    background: var(--surface);
    border-radius: 16px;
    border: 1px solid var(--border);
    overflow: visible;
    min-height: 100%;
    box-shadow: var(--shadow-sm);
}

.calendar { 
    display: grid; 
    grid-template-columns: 100px repeat(var(--cols), minmax(240px, 1fr));
    min-width: max-content;
}
.cal-corner {
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    border-right: 1px solid var(--border);
    position: sticky;
    left: 0;
    top: 0;
    z-index: 5;
}
.cal-head {
    position: sticky;
    top: 0;
    z-index: 4;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    border-right: 1px solid var(--border-light);
    padding: 18px 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    font-size: 16px;
    font-weight: 600;
}
.cal-head-dot { width: 12px; height: 12px; border-radius: 50%; }

/* ═══════════ TIME RAIL (FIXED CUTOFF) ═══════════ */
.cal-times {
    position: sticky;
    left: 0;
    z-index: 3;
    background: var(--bg);
    border-right: 1px solid var(--border);
    width: 100px;
    padding-top: 14px;
    box-sizing: border-box;
}
.cal-time {
    position: absolute;
    left: 0;
    right: 12px;
    transform: translateY(-50%);
    font-size: 13px;
    font-weight: 600;
    color: var(--text-muted);
    text-align: right;
}

.cal-col {
    position: relative;
    background: var(--surface);
    border-right: 1px solid var(--border-light);
    transition: background 0.15s;
}
.cal-col:last-child { border-right: none; }
.cal-col.over { background: var(--accent-light); }

.cal-line {
    position: absolute;
    left: 0;
    right: 0;
    border-top: 1px solid var(--border-light);
    pointer-events: none;
}

/* ═══════════ OFF-HOURS ZONES (GREY DIAGONAL STRIPES) ═══════════ */
.cal-off {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    background: #e2e8f0;
    background-image: repeating-linear-gradient(
        -45deg,
        transparent,
        transparent 8px,
        #94a3b8 8px,
        #94a3b8 9px
    );
    pointer-events: none;
    border-bottom: 1px solid var(--border);
}
.cal-off-b { top: auto; bottom: 0; border-bottom: none; border-top: 1px solid var(--border); }

/* ═══════════ EVENTS ═══════════ */
.ev {
    position: absolute;
    left: 6px;
    right: 6px;
    min-height: 32px;
    border-radius: 8px;
    background: var(--bg);
    border: 2px solid var(--c);
    cursor: pointer;
    z-index: 10;
    display: flex;
    flex-direction: column;
    transition: all 0.15s;
    overflow: hidden;
}
.ev:hover { z-index: 20; box-shadow: var(--shadow-md); transform: translateY(-1px); }
.ev.sel { box-shadow: 0 0 0 3px var(--accent), var(--shadow-md); z-index: 30; }
.ev.moving { opacity: 0.6; }
.ev.resizing { z-index: 40; }

.ev-body {
    flex: 1;
    padding: 6px 10px;
    display: flex;
    flex-direction: column;
    justify-content: center;
}
.ev-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.ev-time {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
    margin-top: 3px;
}

.ev-sm { min-height: 28px; }
.ev-sm .ev-body { flex-direction: row; align-items: center; gap: 8px; padding: 4px 8px; }
.ev-sm .ev-name { font-size: 12px; flex-shrink: 1; min-width: 0; }
.ev-sm .ev-time { font-size: 11px; margin-top: 0; opacity: 0.7; white-space: nowrap; flex-shrink: 0; }

.ev-handle {
    position: absolute;
    left: 0;
    right: 0;
    height: 10px;
    cursor: ns-resize;
    background: transparent;
    z-index: 5;
}
.ev-handle-t { top: 0; }
.ev-handle-b { bottom: 0; }
.ev-handle:hover { background: rgba(79, 70, 229, 0.1); }

/* ═══════════ MODAL ═══════════ */
.modal-wrap {
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, 0.75);
    backdrop-filter: blur(8px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
}
.modal {
    background: #ffffff;
    border-radius: 16px;
    width: 420px;
    max-width: calc(100vw - 48px);
    max-height: calc(100vh - 48px);
    overflow: hidden;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(0,0,0,0.05);
}
.modal-head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 20px 24px;
    border-bottom: 1px solid var(--border);
    background: #f8fafc;
}
.modal-icon {
    width: 36px;
    height: 36px;
    border-radius: 10px;
    background: var(--c);
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 15px;
    font-weight: 700;
}
.modal-head h2 { margin: 0; font-size: 16px; font-weight: 600; flex: 1; }
.modal-x {
    width: 32px;
    height: 32px;
    background: transparent;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-size: 20px;
    color: var(--text-muted);
    transition: all 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
}
.modal-x:hover { background: #e2e8f0; color: var(--text-secondary); }
.modal-body { padding: 24px; background: #ffffff; }
.modal-foot {
    display: flex;
    gap: 10px;
    padding: 16px 24px;
    background: #f8fafc;
    border-top: 1px solid var(--border);
}
.modal-foot .btn { flex: 1; padding: 12px 20px; }

/* ═══════════ FORM ═══════════ */
.mf { margin-bottom: 20px; }
.mf:last-child { margin-bottom: 0; }
.mf label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
    margin-bottom: 8px;
}
.mf input:not([type="checkbox"]), .mf select {
    width: 100%;
    height: 42px;
    font-size: 14px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0 14px;
    color: var(--text);
    font-family: inherit;
}
.mf input:focus, .mf select:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-light);
    outline: none;
}
.mf-row { display: flex; gap: 16px; }
.mf-row .mf { flex: 1; }

.time-box {
    display: flex;
    align-items: center;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
}
.time-box:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-light); }
.time-box input {
    flex: 1;
    height: 42px !important;
    border: none !important;
    background: none !important;
    text-align: center;
    font-weight: 600;
    font-size: 14px !important;
    padding: 0 !important;
}
.time-box button {
    width: 40px;
    height: 42px;
    border: none;
    background: var(--bg);
    cursor: pointer;
    font-size: 18px;
    color: var(--text-muted);
    transition: all 0.15s;
}
.time-box button:hover { background: var(--border-light); color: var(--text); }
.time-box button:first-child { border-right: 1px solid var(--border-light); }
.time-box button:last-child { border-left: 1px solid var(--border-light); }

.dur-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
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
    transition: all 0.15s;
}
.dur-row button:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-light); }

.checks {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 6px;
    max-height: 160px;
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
    transition: all 0.15s;
    border: 1px solid transparent;
}
.checks label:hover { background: var(--accent-light); border-color: var(--accent-light); }
.checks input { width: 16px; height: 16px; margin: 0; accent-color: var(--accent); }

/* ═══════════ LOCATION BUTTONS (Multi-select) ═══════════ */
.loc-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 12px;
    background: var(--bg);
    border-radius: 8px;
    border: 1px solid var(--border);
    max-height: 180px;
    overflow-y: auto;
}
.loc-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 10px 14px;
    background: var(--surface);
    border: 2px solid var(--border);
    border-radius: 8px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    transition: all 0.15s;
    min-width: 80px;
}
.loc-btn:hover {
    border-color: var(--accent);
    background: var(--accent-light);
}
.loc-btn.active {
    border-color: var(--accent);
    background: var(--accent);
    color: white;
}
.loc-btn.active .loc-type {
    color: rgba(255,255,255,0.8);
}
.loc-type {
    font-size: 10px;
    font-weight: 500;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.03em;
}

/* ═══════════ NOTIFY ═══════════ */
#notify {
    position: fixed;
    bottom: 28px;
    left: 50%;
    transform: translateX(-50%) translateY(8px);
    background: var(--text);
    color: white;
    padding: 14px 28px;
    border-radius: 12px;
    font-size: 14px;
    font-weight: 600;
    opacity: 0;
    box-shadow: var(--shadow-xl);
    transition: all 0.25s;
    z-index: 9999;
    pointer-events: none;
}
#notify.on { opacity: 1; transform: translateX(-50%) translateY(0); }

/* ═══════════ RESPONSIVE ═══════════ */
@media (max-width: 1100px) {
    .top { flex-wrap: wrap; height: auto; padding: 12px 16px; gap: 10px; }
    .top-right { flex-wrap: wrap; gap: 8px; }
    .tool-group { padding-left: 0; border-left: none; }
    .side { width: 160px; }
    .blocks { grid-template-columns: 1fr; }
}
@media (max-width: 768px) {
    .side { width: 140px; }
    .block { padding: 8px 4px; }
    .block-dot { width: 24px; height: 24px; font-size: 10px; }
}
</style>`;

// Init
const init = () => {
    container = document.getElementById('master-scheduler-content');
    if (!container) return;
    
    // Hide the main page title when Schedule Builder is shown
    const pageTitle = document.querySelector('.app-page-title');
    if (pageTitle) pageTitle.style.display = 'none';
    
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
    // Restore page title when leaving
    const pageTitle = document.querySelector('.app-page-title');
    if (pageTitle) pageTitle.style.display = '';
};
window.refreshMasterSchedulerFromCloud = fills;

})();
