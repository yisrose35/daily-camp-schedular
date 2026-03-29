// =============================================================================
// campistry_go_map_editor.js v2 — Route Map Editing Toolbar
// Modes: Select, Reorder, Move, Erase, Draw
// All edits persist via CampistryGo._save() + _refreshRoutes()
// =============================================================================
(function() {
    'use strict';

    let _editMode = 'select';
    let _reorderQueue = [];
    let _reorderBusId = null;
    let _reorderShiftIdx = null;
    let _drawPoints = [];
    let _drawPolyline = null;
    let _drawMarkers = [];
    let _drawBusId = null;
    let _drawShiftIdx = null;
    let _drawStartStop = null;
    let _drawEndStop = null;
    let _moveSourceStop = null;
    let _moveSourceBusId = null;
    let _moveSourceShiftIdx = null;
    let _erasedStops = [];

    const CG = () => window.CampistryGo;
    const getMap = () => CG()?._getMap?.();

    // ── TOOLBAR ──
    function createToolbar() {
        if (document.getElementById('mapEditToolbar')) return;
        const bar = document.createElement('div');
        bar.id = 'mapEditToolbar';
        bar.innerHTML = `
            <div class="met-bar">
                <button class="met-btn active" data-mode="select" title="View stops & popups">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg>
                    <span>Select</span>
                </button>
                <button class="met-btn" data-mode="reorder" title="Click stops in new order">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>
                    <span>Reorder</span>
                </button>
                <button class="met-btn" data-mode="move" title="Move stop to another bus">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="5 9 2 12 5 15"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/></svg>
                    <span>Move</span>
                </button>
                <button class="met-btn" data-mode="erase" title="Remove a stop">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                    <span>Erase</span>
                </button>
                <button class="met-btn" data-mode="draw" title="Draw custom route path">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
                    <span>Draw</span>
                </button>
                <div class="met-sep"></div>
                <button class="met-action" id="metUndoBtn" style="display:none;" title="Undo last point">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                </button>
                <button class="met-action met-cancel-btn" id="metCancelBtn" style="display:none;">Cancel</button>
                <button class="met-action met-apply-btn" id="metApplyBtn" style="display:none;">Apply</button>
            </div>
            <div class="met-hint" id="metStatus"></div>`;

        const mapCard = document.getElementById('routeMapCard');
        const mapEl = document.getElementById('routeMap');
        if (mapCard && mapEl) mapCard.insertBefore(bar, mapEl);

        bar.querySelectorAll('.met-btn[data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
        document.getElementById('metCancelBtn').addEventListener('click', cancel);
        document.getElementById('metApplyBtn').addEventListener('click', apply);
        document.getElementById('metUndoBtn').addEventListener('click', undo);
    }

    // ── STYLES ──
    function injectStyles() {
        if (document.getElementById('metCSS')) return;
        const s = document.createElement('style');
        s.id = 'metCSS';
        s.textContent = `
#mapEditToolbar{margin-bottom:0}
.met-bar{display:flex;align-items:center;gap:2px;padding:5px 8px;background:var(--surface-primary,#fff);border:1px solid var(--border-light,#e5e7eb);border-bottom:none;border-radius:var(--radius-md,8px) var(--radius-md,8px) 0 0}
.met-btn{display:inline-flex;align-items:center;gap:4px;padding:5px 10px;border:1px solid transparent;border-radius:6px;background:none;cursor:pointer;font:.7rem/1 'DM Sans',sans-serif;font-weight:600;color:var(--text-muted,#888);transition:all .15s}
.met-btn:hover{background:var(--surface-secondary,#f5f5f5);color:var(--text-primary,#222)}
.met-btn.active{background:var(--blue-50,#eff6ff);color:var(--blue-700,#1d4ed8);border-color:var(--blue-200,#bfdbfe)}
.met-sep{width:1px;height:22px;background:var(--border-light,#e5e7eb);margin:0 4px}
.met-action{padding:4px 10px;border:none;border-radius:5px;cursor:pointer;font:.7rem/1 'DM Sans',sans-serif;font-weight:700;background:none}
.met-cancel-btn{color:var(--red-500,#ef4444)}.met-cancel-btn:hover{background:var(--red-50,#fef2f2)}
.met-apply-btn{color:#fff;background:var(--blue-600,#2563eb)}.met-apply-btn:hover{background:var(--blue-700,#1d4ed8)}
.met-hint{padding:4px 12px;font:.72rem/1.4 'DM Sans',sans-serif;color:var(--text-muted,#888);background:var(--surface-secondary,#f9fafb);border:1px solid var(--border-light,#e5e7eb);border-top:none;min-height:20px}
.met-hint:empty{display:none}
.met-reorder-badge{position:absolute;top:-8px;right:-8px;width:18px;height:18px;border-radius:50%;background:#2563eb;color:#fff;font-size:10px;font-weight:800;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.3);z-index:10;pointer-events:none}
.met-erase .leaflet-marker-icon{cursor:crosshair!important}
.met-draw .leaflet-container{cursor:crosshair!important}
.met-move .leaflet-marker-icon{cursor:grab!important}
`;
        document.head.appendChild(s);
    }

    // ── MODE ──
    function setMode(mode) {
        cancel();
        _editMode = mode;
        document.querySelectorAll('.met-btn[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
        const mc = document.getElementById('routeMap');
        if (mc) { mc.classList.remove('met-erase','met-draw','met-move'); if (mode !== 'select' && mode !== 'reorder') mc.classList.add('met-' + mode); }

        const hints = {
            select: '',
            reorder: '① Click a stop to select its bus. Then click stops in the new order. <b>Apply</b> to save.',
            move: '① Click a stop to pick it up. ② Click a stop on a different bus to drop it there.',
            erase: 'Click any stop to remove it from the route.',
            draw: '① Click the start stop. ② Click the end stop. ③ Click map to add waypoints. <b>Apply</b> to save.'
        };
        setStatus(hints[mode] || '');
        document.getElementById('metCancelBtn').style.display = mode === 'select' ? 'none' : '';
        document.getElementById('metApplyBtn').style.display = 'none';
        document.getElementById('metUndoBtn').style.display = 'none';
    }

    function setStatus(html) { const el = document.getElementById('metStatus'); if (el) el.innerHTML = html; }

    function cancel() {
        _reorderQueue = []; _reorderBusId = null; _reorderShiftIdx = null;
        _drawPoints = []; _drawStartStop = null; _drawEndStop = null; _drawBusId = null;
        _moveSourceStop = null; _moveSourceBusId = null;
        const map = getMap();
        if (map && _drawPolyline) { map.removeLayer(_drawPolyline); _drawPolyline = null; }
        _drawMarkers.forEach(m => { if (map) map.removeLayer(m); });
        _drawMarkers = [];
        document.querySelectorAll('.met-reorder-badge').forEach(e => e.remove());
        document.getElementById('metApplyBtn').style.display = 'none';
        document.getElementById('metUndoBtn').style.display = 'none';
    }

    function apply() {
        if (_editMode === 'reorder') applyReorder();
        else if (_editMode === 'draw') applyDraw();
        cancel();
    }

    function undo() {
        if (_editMode === 'draw' && _drawPoints.length) {
            _drawPoints.pop();
            const map = getMap();
            const last = _drawMarkers.pop();
            if (map && last) map.removeLayer(last);
            redrawPreview();
            if (!_drawPoints.length) document.getElementById('metApplyBtn').style.display = 'none';
            setStatus(_drawPoints.length + ' point(s). Click more or <b>Apply</b>.');
        }
    }

    // ═══════════════════════════════════════════
    // STOP CLICK ROUTER (called from campistry_go.js)
    // ═══════════════════════════════════════════
    window._mapEditorStopClick = function(stop, busId, shiftIdx) {
        if (_editMode === 'select') return false;
        if (_editMode === 'reorder') return onReorderClick(stop, busId, shiftIdx);
        if (_editMode === 'move') return onMoveClick(stop, busId, shiftIdx);
        if (_editMode === 'erase') return onEraseClick(stop, busId, shiftIdx);
        if (_editMode === 'draw') return onDrawStopClick(stop, busId, shiftIdx);
        return false;
    };

    // ═══════════════════════════════════════════
    // REORDER
    // ═══════════════════════════════════════════
    function onReorderClick(stop, busId, shiftIdx) {
        if (!_reorderBusId) {
            _reorderBusId = busId;
            _reorderShiftIdx = shiftIdx;
            setStatus('Bus selected. Now click stops in the new order. <b>Apply</b> when done.');
        }
        if (busId !== _reorderBusId) { setStatus('⚠ Different bus. Click stops on the <b>same bus</b>.'); return true; }

        const idx = _reorderQueue.findIndex(s => s.stopNum === stop.stopNum);
        if (idx >= 0) {
            _reorderQueue = _reorderQueue.slice(0, idx);
        } else {
            _reorderQueue.push({ ...stop });
        }
        document.querySelectorAll('.met-reorder-badge').forEach(e => e.remove());
        _reorderQueue.forEach((s, i) => addBadge(s.stopNum, i + 1));
        setStatus(_reorderQueue.length + ' stop(s) ordered. Click more or <b>Apply</b>.');
        document.getElementById('metApplyBtn').style.display = _reorderQueue.length >= 2 ? '' : 'none';
        return true;
    }

    function addBadge(origNum, newNum) {
        document.querySelectorAll('.stop-marker-icon').forEach(el => {
            if (el.textContent.trim() === String(origNum)) {
                el.style.position = 'relative';
                const b = document.createElement('div');
                b.className = 'met-reorder-badge';
                b.textContent = newNum;
                el.appendChild(b);
            }
        });
    }

    function applyReorder() {
        const routes = CG()?._getSavedRoutes();
        if (!routes || !_reorderBusId) return;
        const sr = routes[_reorderShiftIdx];
        if (!sr) return;
        const route = sr.routes.find(r => r.busId === _reorderBusId);
        if (!route) return;

        const newOrder = [];
        _reorderQueue.forEach(qs => {
            const found = route.stops.find(s => s.stopNum === qs.stopNum);
            if (found) newOrder.push(found);
        });
        route.stops.forEach(s => { if (!newOrder.find(n => n.stopNum === s.stopNum)) newOrder.push(s); });
        newOrder.forEach((s, i) => s.stopNum = i + 1);
        route.stops = newOrder;
        route.camperCount = route.stops.reduce((s, st) => s + st.campers.length, 0);

        CG()._clearGeomCache(_reorderBusId + '_' + _reorderShiftIdx);
        CG()._setSavedRoutes(routes);
        CG()._save();
        CG()._refreshRoutes();
        toast('Stops reordered on ' + route.busName);
    }

    // ═══════════════════════════════════════════
    // MOVE
    // ═══════════════════════════════════════════
    function onMoveClick(stop, busId, shiftIdx) {
        if (!_moveSourceStop) {
            _moveSourceStop = stop;
            _moveSourceBusId = busId;
            _moveSourceShiftIdx = shiftIdx;
            setStatus('Picked up <b>Stop ' + stop.stopNum + '</b>. Now click a stop on the target bus.');
            return true;
        }
        if (busId === _moveSourceBusId) { setStatus('⚠ Same bus. Click a stop on a <b>different</b> bus.'); return true; }

        const routes = CG()?._getSavedRoutes();
        if (!routes) return true;
        const sr = routes[_moveSourceShiftIdx];
        if (!sr) return true;
        const srcRoute = sr.routes.find(r => r.busId === _moveSourceBusId);
        const tgtRoute = sr.routes.find(r => r.busId === busId);
        if (!srcRoute || !tgtRoute) return true;

        const si = srcRoute.stops.findIndex(s => s.stopNum === _moveSourceStop.stopNum);
        if (si < 0) return true;
        const moved = srcRoute.stops.splice(si, 1)[0];
        srcRoute.stops.forEach((s, i) => s.stopNum = i + 1);
        srcRoute.camperCount = srcRoute.stops.reduce((s, st) => s + st.campers.length, 0);

        const ti = tgtRoute.stops.findIndex(s => s.stopNum === stop.stopNum);
        tgtRoute.stops.splice(ti >= 0 ? ti + 1 : tgtRoute.stops.length, 0, moved);
        tgtRoute.stops.forEach((s, i) => s.stopNum = i + 1);
        tgtRoute.camperCount = tgtRoute.stops.reduce((s, st) => s + st.campers.length, 0);

        CG()._clearGeomCache(_moveSourceBusId + '_' + _moveSourceShiftIdx);
        CG()._clearGeomCache(busId + '_' + _moveSourceShiftIdx);
        CG()._setSavedRoutes(routes);
        CG()._save();
        CG()._refreshRoutes();

        toast(moved.campers.map(c => c.name).join(', ') + ' → ' + tgtRoute.busName);
        _moveSourceStop = null;
        _moveSourceBusId = null;
        setStatus('Done! Click another stop to move, or switch mode.');
        return true;
    }

    // ═══════════════════════════════════════════
    // ERASE
    // ═══════════════════════════════════════════
    function onEraseClick(stop, busId, shiftIdx) {
        const names = stop.campers.map(c => c.name).join(', ') || 'staff stop';
        if (!confirm('Remove Stop ' + stop.stopNum + '?\n\n' + names)) return true;

        const routes = CG()?._getSavedRoutes();
        if (!routes) return true;
        const sr = routes[shiftIdx];
        if (!sr) return true;
        const route = sr.routes.find(r => r.busId === busId);
        if (!route) return true;

        route.stops = route.stops.filter(s => s.stopNum !== stop.stopNum);
        route.stops.forEach((s, i) => s.stopNum = i + 1);
        route.camperCount = route.stops.reduce((s, st) => s + st.campers.length, 0);

        CG()._clearGeomCache(busId + '_' + shiftIdx);
        CG()._setSavedRoutes(routes);
        CG()._save();
        CG()._refreshRoutes();
        toast('Stop removed — ' + names);
        return true;
    }

    // ═══════════════════════════════════════════
    // DRAW
    // ═══════════════════════════════════════════
    function onDrawStopClick(stop, busId, shiftIdx) {
        if (!_drawStartStop) {
            _drawStartStop = stop;
            _drawBusId = busId;
            _drawShiftIdx = shiftIdx;
            setStatus('Start: <b>Stop ' + stop.stopNum + '</b>. Click the end stop.');
            return true;
        }
        if (!_drawEndStop) {
            if (busId !== _drawBusId) { setStatus('⚠ Pick an end stop on the <b>same bus</b>.'); return true; }
            _drawEndStop = stop;
            setStatus('Stop ' + _drawStartStop.stopNum + ' → ' + _drawEndStop.stopNum + '. Click the map to draw waypoints. <b>Apply</b> to save.');
            document.getElementById('metUndoBtn').style.display = '';
            const map = getMap();
            if (map && !map._metDrawHook) {
                map.on('click', function(e) {
                    if (_editMode === 'draw' && _drawStartStop && _drawEndStop) addDrawPoint(e.latlng);
                });
                map._metDrawHook = true;
            }
            return true;
        }
        return true;
    }

    function addDrawPoint(latlng) {
        _drawPoints.push([latlng.lat, latlng.lng]);
        const map = getMap();
        if (map) {
            const m = L.circleMarker([latlng.lat, latlng.lng], {
                radius: 5, color: '#1d4ed8', fillColor: '#60a5fa', fillOpacity: 1, weight: 2
            }).addTo(map);
            _drawMarkers.push(m);
            redrawPreview();
        }
        document.getElementById('metApplyBtn').style.display = '';
        setStatus(_drawPoints.length + ' waypoint(s). Click more or <b>Apply</b>.');
    }

    function redrawPreview() {
        const map = getMap();
        if (!map) return;
        if (_drawPolyline) map.removeLayer(_drawPolyline);
        if (!_drawPoints.length) { _drawPolyline = null; return; }
        const pts = [[_drawStartStop.lat, _drawStartStop.lng], ..._drawPoints, [_drawEndStop.lat, _drawEndStop.lng]];
        _drawPolyline = L.polyline(pts, { color: '#2563eb', weight: 4, opacity: 0.8, dashArray: '8,6' }).addTo(map);
    }

    function applyDraw() {
        if (!_drawStartStop || !_drawEndStop || !_drawPoints.length) return;
        const routes = CG()?._getSavedRoutes();
        if (!routes) return;
        const sr = routes[_drawShiftIdx];
        if (!sr) return;
        const route = sr.routes.find(r => r.busId === _drawBusId);
        if (!route) return;

        if (!route._customPaths) route._customPaths = {};
        route._customPaths[_drawStartStop.stopNum + '_' + _drawEndStop.stopNum] = [
            [_drawStartStop.lat, _drawStartStop.lng], ..._drawPoints, [_drawEndStop.lat, _drawEndStop.lng]
        ];

        CG()._clearGeomCache(_drawBusId + '_' + _drawShiftIdx);
        CG()._setSavedRoutes(routes);
        CG()._save();
        CG()._refreshRoutes();
        toast('Custom path: Stop ' + _drawStartStop.stopNum + ' → ' + _drawEndStop.stopNum);
    }

    // ── HELPERS ──
    function toast(msg) {
        const el = document.getElementById('toastEl');
        if (!el) return;
        el.textContent = msg; el.className = 'toast';
        requestAnimationFrame(() => { el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2500); });
    }

    // ── INIT ──
    function init() {
        injectStyles();
        const poll = setInterval(() => {
            if (document.getElementById('routeMapCard') && document.getElementById('routeMap')) {
                clearInterval(poll);
                createToolbar();
                console.log('[Go] Map editor v2 loaded');
            }
        }, 500);
    }

    window.CampistryGoMapEditor = { setMode, getMode: () => _editMode };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
