// =============================================================================
// campistry_go_map_editor.js — Route Map Editing Toolbar
// Modes: Select, Reorder, Move, Erase, Draw
// =============================================================================
(function() {
    'use strict';

    let _editMode = 'select'; // 'select' | 'reorder' | 'move' | 'erase' | 'draw'
    let _reorderQueue = [];   // stop objects clicked in sequence
    let _reorderBusId = null;
    let _reorderShiftIdx = null;
    let _drawPoints = [];     // lat/lng points for custom path drawing
    let _drawPolyline = null; // temp polyline while drawing
    let _drawMarkers = [];    // temp markers for draw points
    let _drawSegmentBusId = null;
    let _drawSegmentShiftIdx = null;
    let _drawSegmentStart = null; // stop before custom segment
    let _drawSegmentEnd = null;   // stop after custom segment
    let _moveSourceStop = null;
    let _moveSourceBusId = null;
    let _moveSourceShiftIdx = null;

    // ── TOOLBAR HTML ──
    function createToolbar() {
        if (document.getElementById('mapEditToolbar')) return;

        const bar = document.createElement('div');
        bar.id = 'mapEditToolbar';
        bar.innerHTML = `
            <div class="met-bar">
                <button class="met-btn active" data-mode="select" title="Select & view stops">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg>
                    <span>Select</span>
                </button>
                <button class="met-btn" data-mode="reorder" title="Click stops in order to reorder">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M3 12h18M3 18h18"/><circle cx="8" cy="6" r="2" fill="currentColor"/><circle cx="14" cy="12" r="2" fill="currentColor"/><circle cx="8" cy="18" r="2" fill="currentColor"/></svg>
                    <span>Reorder</span>
                </button>
                <button class="met-btn" data-mode="move" title="Click a stop then click a bus to move it">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>
                    <span>Move</span>
                </button>
                <button class="met-btn" data-mode="erase" title="Click a stop to remove it from the route">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                    <span>Erase</span>
                </button>
                <button class="met-btn" data-mode="draw" title="Draw a custom path between stops">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/></svg>
                    <span>Draw</span>
                </button>
                <div class="met-divider"></div>
                <button class="met-btn met-undo" id="metUndoBtn" title="Undo last action" style="display:none;">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                </button>
                <button class="met-btn met-cancel" id="metCancelBtn" title="Cancel current action" style="display:none;">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    <span>Cancel</span>
                </button>
                <button class="met-btn met-apply" id="metApplyBtn" title="Apply changes" style="display:none;">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
                    <span>Apply</span>
                </button>
            </div>
            <div class="met-status" id="metStatus"></div>
        `;

        // Insert before the map
        const mapCard = document.getElementById('routeMapCard');
        if (mapCard) {
            const mapEl = document.getElementById('routeMap');
            if (mapEl) mapCard.insertBefore(bar, mapEl);
        }

        // Event listeners
        bar.querySelectorAll('.met-btn[data-mode]').forEach(btn => {
            btn.addEventListener('click', () => setEditMode(btn.dataset.mode));
        });
        document.getElementById('metCancelBtn').addEventListener('click', cancelAction);
        document.getElementById('metApplyBtn').addEventListener('click', applyAction);
        document.getElementById('metUndoBtn')?.addEventListener('click', undoLastDrawPoint);
    }

    // ── STYLES ──
    function injectStyles() {
        if (document.getElementById('mapEditorStyles')) return;
        const style = document.createElement('style');
        style.id = 'mapEditorStyles';
        style.textContent = `
            #mapEditToolbar { margin-bottom: 0; }
            .met-bar {
                display: flex; align-items: center; gap: 2px;
                padding: 6px 8px; background: var(--surface-primary, #fff);
                border: 1px solid var(--border-light, #e5e7eb);
                border-bottom: none;
                border-radius: var(--radius-md, 8px) var(--radius-md, 8px) 0 0;
            }
            .met-btn {
                display: inline-flex; align-items: center; gap: 4px;
                padding: 5px 10px; border: 1px solid transparent;
                border-radius: 6px; background: none; cursor: pointer;
                font-size: .75rem; font-weight: 600; font-family: inherit;
                color: var(--text-muted, #888); transition: all .15s;
            }
            .met-btn:hover { background: var(--surface-secondary, #f5f5f5); color: var(--text-primary, #222); }
            .met-btn.active {
                background: var(--blue-50, #eff6ff); color: var(--blue-700, #1d4ed8);
                border-color: var(--blue-200, #bfdbfe);
            }
            .met-btn.met-cancel { color: var(--red-500, #ef4444); }
            .met-btn.met-cancel:hover { background: var(--red-50, #fef2f2); }
            .met-btn.met-apply { color: var(--green-600, #16a34a); }
            .met-btn.met-apply:hover { background: var(--green-50, #f0fdf4); }
            .met-btn.met-undo { color: var(--text-muted, #888); }
            .met-divider { width: 1px; height: 24px; background: var(--border-light, #e5e7eb); margin: 0 4px; }
            .met-status {
                padding: 4px 12px; font-size: .75rem; font-weight: 500;
                color: var(--text-muted, #888); min-height: 22px;
                background: var(--surface-secondary, #f9fafb);
                border: 1px solid var(--border-light, #e5e7eb); border-top: none;
                font-family: inherit;
            }
            .met-status:empty { display: none; }
            /* Reorder: pulsing stops */
            .stop-marker-reorder { animation: met-pulse 1s infinite; }
            @keyframes met-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(59,130,246,.5); } 50% { box-shadow: 0 0 0 8px rgba(59,130,246,0); } }
            /* Erase: red hover */
            .met-erase-mode .stop-marker-icon:hover { outline: 3px solid #ef4444 !important; cursor: not-allowed !important; }
            /* Draw: crosshair cursor */
            .met-draw-mode .leaflet-container { cursor: crosshair !important; }
            /* Move: grab cursor on stops */
            .met-move-mode .stop-marker-icon { cursor: grab !important; }
            /* Reorder numbering overlay */
            .met-reorder-num {
                position: absolute; top: -8px; right: -8px;
                width: 18px; height: 18px; border-radius: 50%;
                background: #1d4ed8; color: #fff; font-size: 10px;
                font-weight: 700; display: flex; align-items: center;
                justify-content: center; border: 2px solid #fff;
                box-shadow: 0 1px 3px rgba(0,0,0,.3); z-index: 10;
            }
        `;
        document.head.appendChild(style);
    }

    // ── MODE SWITCHING ──
    function setEditMode(mode) {
        cancelAction(); // clean up any in-progress action
        _editMode = mode;

        // Update button states
        document.querySelectorAll('.met-btn[data-mode]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });

        // Update map container classes
        const mapContainer = document.getElementById('routeMap');
        if (mapContainer) {
            mapContainer.classList.remove('met-erase-mode', 'met-draw-mode', 'met-move-mode');
            if (mode === 'erase') mapContainer.classList.add('met-erase-mode');
            if (mode === 'draw') mapContainer.classList.add('met-draw-mode');
            if (mode === 'move') mapContainer.classList.add('met-move-mode');
        }

        // Update status
        const status = document.getElementById('metStatus');
        const msgs = {
            select: '',
            reorder: 'Click a bus route first, then click stops in the order you want them.',
            move: 'Click a stop to pick it up, then click a different bus\'s route to drop it there.',
            erase: 'Click a stop to remove it from the route.',
            draw: 'Click two stops to define a segment, then click on the map to draw a custom path between them.'
        };
        if (status) status.textContent = msgs[mode] || '';

        // Show/hide action buttons
        document.getElementById('metCancelBtn').style.display = mode === 'select' ? 'none' : '';
        document.getElementById('metApplyBtn').style.display = 'none';
        document.getElementById('metUndoBtn').style.display = 'none';

        // Re-enable/disable stop dragging based on mode
        updateStopInteractivity();
    }

    function updateStopInteractivity() {
        // In select mode, stops are draggable (default behavior)
        // In other modes, we intercept clicks instead
    }

    // ── CANCEL / APPLY ──
    function cancelAction() {
        _reorderQueue = [];
        _reorderBusId = null;
        _reorderShiftIdx = null;
        _drawPoints = [];
        _drawSegmentStart = null;
        _drawSegmentEnd = null;
        _moveSourceStop = null;

        // Remove temp draw elements
        if (_drawPolyline && window.CampistryGo?._getMap?.()) {
            window.CampistryGo._getMap().removeLayer(_drawPolyline);
            _drawPolyline = null;
        }
        _drawMarkers.forEach(m => {
            if (window.CampistryGo?._getMap?.()) window.CampistryGo._getMap().removeLayer(m);
        });
        _drawMarkers = [];

        // Remove reorder number overlays
        document.querySelectorAll('.met-reorder-num').forEach(el => el.remove());

        document.getElementById('metApplyBtn').style.display = 'none';
        document.getElementById('metUndoBtn').style.display = 'none';
        const status = document.getElementById('metStatus');
        if (status && _editMode !== 'select') {
            const msgs = {
                reorder: 'Click a bus route first, then click stops in the order you want them.',
                move: 'Click a stop to pick it up, then click a different bus\'s route to drop it there.',
                erase: 'Click a stop to remove it from the route.',
                draw: 'Click two stops to define a segment, then click on the map to draw a custom path between them.'
            };
            status.textContent = msgs[_editMode] || '';
        }
    }

    function applyAction() {
        if (_editMode === 'reorder' && _reorderQueue.length >= 2) {
            applyReorder();
        } else if (_editMode === 'draw' && _drawPoints.length >= 2) {
            applyCustomPath();
        }
        cancelAction();
    }

    // ═══════════════════════════════════════════
    // REORDER MODE
    // ═══════════════════════════════════════════
    function handleReorderClick(stop, busId, shiftIdx) {
        if (_editMode !== 'reorder') return;

        // First click sets the bus
        if (!_reorderBusId) {
            _reorderBusId = busId;
            _reorderShiftIdx = shiftIdx;
            document.getElementById('metStatus').textContent =
                'Now click stops in the order you want. Click Apply when done.';
        }

        // Only accept stops from same bus
        if (busId !== _reorderBusId) {
            document.getElementById('metStatus').textContent =
                '⚠ That stop is on a different bus. Click stops on the same bus.';
            return;
        }

        // Check if already in queue
        const existing = _reorderQueue.findIndex(s => s.stopNum === stop.stopNum);
        if (existing >= 0) {
            // Remove it and everything after
            _reorderQueue = _reorderQueue.slice(0, existing);
            document.querySelectorAll('.met-reorder-num').forEach(el => el.remove());
            _reorderQueue.forEach((s, i) => addReorderNumber(s, i + 1));
        } else {
            _reorderQueue.push(stop);
            addReorderNumber(stop, _reorderQueue.length);
        }

        document.getElementById('metStatus').textContent =
            _reorderQueue.length + ' stop(s) ordered. Click more or Apply.';
        document.getElementById('metApplyBtn').style.display = _reorderQueue.length >= 2 ? '' : 'none';
    }

    function addReorderNumber(stop, num) {
        // Find the stop marker on the map and add a number badge
        const markers = document.querySelectorAll('.stop-marker-icon');
        markers.forEach(el => {
            if (el.textContent.trim() === String(stop.stopNum)) {
                const badge = document.createElement('div');
                badge.className = 'met-reorder-num';
                badge.textContent = num;
                el.style.position = 'relative';
                el.appendChild(badge);
            }
        });
    }

    function applyReorder() {
        if (!window.CampistryGo || !_reorderBusId || _reorderQueue.length < 2) return;

        const D = getSavedRoutes();
        if (!D) return;
        const sr = D[_reorderShiftIdx];
        if (!sr) return;
        const route = sr.routes.find(r => r.busId === _reorderBusId);
        if (!route) return;

        // Build new order: reordered stops first, then any stops not clicked (appended at end)
        const reorderedAddrs = _reorderQueue.map(s => s.address);
        const newOrder = [];
        _reorderQueue.forEach(s => {
            const found = route.stops.find(rs => rs.stopNum === s.stopNum);
            if (found) newOrder.push(found);
        });
        // Append any stops not in the reorder queue
        route.stops.forEach(s => {
            if (!newOrder.find(ns => ns.stopNum === s.stopNum)) {
                newOrder.push(s);
            }
        });
        // Renumber
        newOrder.forEach((s, i) => s.stopNum = i + 1);
        route.stops = newOrder;
        route.camperCount = route.stops.reduce((s, st) => s + st.campers.length, 0);

        // Clear geometry cache for this bus
        const ck = _reorderBusId + '_' + _reorderShiftIdx;
        if (window._routeGeomCache) delete window._routeGeomCache[ck];

        savAndRefresh();
        toast('Stops reordered on ' + route.busName);
    }

    // ═══════════════════════════════════════════
    // MOVE MODE (stop from one bus to another)
    // ═══════════════════════════════════════════
    function handleMoveClick(stop, busId, shiftIdx) {
        if (_editMode !== 'move') return;

        if (!_moveSourceStop) {
            // Pick up the stop
            _moveSourceStop = stop;
            _moveSourceBusId = busId;
            _moveSourceShiftIdx = shiftIdx;
            document.getElementById('metStatus').textContent =
                'Picked up stop ' + stop.stopNum + ' (' + stop.campers.map(c => c.name).join(', ') + '). Now click a stop on the target bus.';
            return;
        }

        // Drop onto target bus
        if (busId === _moveSourceBusId) {
            document.getElementById('metStatus').textContent =
                '⚠ Same bus — click a stop on a different bus to move there.';
            return;
        }

        // Use existing moveCamperToBus for each camper
        const camperNames = _moveSourceStop.campers.map(c => c.name);
        camperNames.forEach(name => {
            if (window.CampistryGo?.moveCamperToBus) {
                // We need direct route manipulation instead
            }
        });

        // Direct route manipulation
        const D = getSavedRoutes();
        if (!D) return;
        const sr = D[_moveSourceShiftIdx];
        if (!sr) return;

        const srcRoute = sr.routes.find(r => r.busId === _moveSourceBusId);
        const tgtRoute = sr.routes.find(r => r.busId === busId);
        if (!srcRoute || !tgtRoute) return;

        // Remove stop from source
        const srcIdx = srcRoute.stops.findIndex(s => s.stopNum === _moveSourceStop.stopNum);
        if (srcIdx < 0) return;
        const removed = srcRoute.stops.splice(srcIdx, 1)[0];
        srcRoute.stops.forEach((s, i) => s.stopNum = i + 1);
        srcRoute.camperCount = srcRoute.stops.reduce((s, st) => s + st.campers.length, 0);

        // Add to target near the clicked stop
        const tgtIdx = tgtRoute.stops.findIndex(s => s.stopNum === stop.stopNum);
        tgtRoute.stops.splice(tgtIdx >= 0 ? tgtIdx + 1 : tgtRoute.stops.length, 0, removed);
        tgtRoute.stops.forEach((s, i) => s.stopNum = i + 1);
        tgtRoute.camperCount = tgtRoute.stops.reduce((s, st) => s + st.campers.length, 0);

        // Clear geometry cache
        const ck1 = _moveSourceBusId + '_' + _moveSourceShiftIdx;
        const ck2 = busId + '_' + _moveSourceShiftIdx;
        if (window._routeGeomCache) { delete window._routeGeomCache[ck1]; delete window._routeGeomCache[ck2]; }

        _moveSourceStop = null;
        _moveSourceBusId = null;

        savAndRefresh();
        toast('Stop moved to ' + tgtRoute.busName);
    }

    // ═══════════════════════════════════════════
    // ERASE MODE
    // ═══════════════════════════════════════════
    function handleEraseClick(stop, busId, shiftIdx) {
        if (_editMode !== 'erase') return;

        const camperNames = stop.campers.map(c => c.name).join(', ');
        if (!confirm('Remove stop ' + stop.stopNum + ' (' + camperNames + ') from the route?\n\nThese campers will be unassigned.')) return;

        const D = getSavedRoutes();
        if (!D) return;
        const sr = D[shiftIdx];
        if (!sr) return;
        const route = sr.routes.find(r => r.busId === busId);
        if (!route) return;

        route.stops = route.stops.filter(s => s.stopNum !== stop.stopNum);
        route.stops.forEach((s, i) => s.stopNum = i + 1);
        route.camperCount = route.stops.reduce((s, st) => s + st.campers.length, 0);

        // Clear geometry cache
        const ck = busId + '_' + shiftIdx;
        if (window._routeGeomCache) delete window._routeGeomCache[ck];

        savAndRefresh();
        toast('Stop removed (' + camperNames + ')');
    }

    // ═══════════════════════════════════════════
    // DRAW MODE (custom path between stops)
    // ═══════════════════════════════════════════
    function handleDrawStopClick(stop, busId, shiftIdx) {
        if (_editMode !== 'draw') return;

        if (!_drawSegmentStart) {
            _drawSegmentStart = stop;
            _drawSegmentBusId = busId;
            _drawSegmentShiftIdx = shiftIdx;
            document.getElementById('metStatus').textContent =
                'Start: Stop ' + stop.stopNum + '. Now click the end stop for this segment.';
            return;
        }

        if (!_drawSegmentEnd) {
            if (busId !== _drawSegmentBusId) {
                document.getElementById('metStatus').textContent = '⚠ Pick an end stop on the same bus.';
                return;
            }
            _drawSegmentEnd = stop;
            document.getElementById('metStatus').textContent =
                'Segment: Stop ' + _drawSegmentStart.stopNum + ' → Stop ' + _drawSegmentEnd.stopNum +
                '. Now click on the map to draw waypoints. Click Apply when done.';
            document.getElementById('metUndoBtn').style.display = '';
            return;
        }
    }

    function handleDrawMapClick(latlng) {
        if (_editMode !== 'draw' || !_drawSegmentStart || !_drawSegmentEnd) return;

        _drawPoints.push([latlng.lat, latlng.lng]);

        // Add marker
        const map = getMap();
        if (map) {
            const marker = L.circleMarker([latlng.lat, latlng.lng], {
                radius: 5, color: '#1d4ed8', fillColor: '#3b82f6',
                fillOpacity: 1, weight: 2
            }).addTo(map);
            _drawMarkers.push(marker);

            // Redraw the preview line
            const allPts = [
                [_drawSegmentStart.lat, _drawSegmentStart.lng],
                ..._drawPoints,
                [_drawSegmentEnd.lat, _drawSegmentEnd.lng]
            ];
            if (_drawPolyline) map.removeLayer(_drawPolyline);
            _drawPolyline = L.polyline(allPts, {
                color: '#1d4ed8', weight: 3, opacity: 0.8, dashArray: '6,6'
            }).addTo(map);
        }

        document.getElementById('metApplyBtn').style.display = '';
        document.getElementById('metStatus').textContent =
            _drawPoints.length + ' waypoint(s). Click more or Apply. Undo removes last point.';
    }

    function undoLastDrawPoint() {
        if (!_drawPoints.length) return;
        _drawPoints.pop();
        const map = getMap();
        if (map) {
            const lastMarker = _drawMarkers.pop();
            if (lastMarker) map.removeLayer(lastMarker);

            if (_drawPolyline) map.removeLayer(_drawPolyline);
            if (_drawPoints.length > 0) {
                const allPts = [
                    [_drawSegmentStart.lat, _drawSegmentStart.lng],
                    ..._drawPoints,
                    [_drawSegmentEnd.lat, _drawSegmentEnd.lng]
                ];
                _drawPolyline = L.polyline(allPts, {
                    color: '#1d4ed8', weight: 3, opacity: 0.8, dashArray: '6,6'
                }).addTo(map);
            } else {
                _drawPolyline = null;
            }
        }

        if (!_drawPoints.length) {
            document.getElementById('metApplyBtn').style.display = 'none';
        }
        document.getElementById('metStatus').textContent =
            _drawPoints.length + ' waypoint(s). Click more or Apply.';
    }

    function applyCustomPath() {
        if (!_drawSegmentStart || !_drawSegmentEnd || !_drawPoints.length) return;

        const fullPath = [
            [_drawSegmentStart.lat, _drawSegmentStart.lng],
            ..._drawPoints,
            [_drawSegmentEnd.lat, _drawSegmentEnd.lng]
        ];

        // Store as a custom geometry override
        const ck = _drawSegmentBusId + '_' + _drawSegmentShiftIdx;
        const segKey = _drawSegmentStart.stopNum + '-' + _drawSegmentEnd.stopNum;

        if (!window._customSegments) window._customSegments = {};
        if (!window._customSegments[ck]) window._customSegments[ck] = {};
        window._customSegments[ck][segKey] = fullPath;

        // Clear cached geometry so it rebuilds with custom segment
        if (window._routeGeomCache) delete window._routeGeomCache[ck];

        savAndRefresh();
        toast('Custom path saved: Stop ' + _drawSegmentStart.stopNum + ' → ' + _drawSegmentEnd.stopNum);
    }

    // ── HELPERS ──
    function getSavedRoutes() {
        try {
            const store = JSON.parse(localStorage.getItem('campistry_go_data'));
            return store?.savedRoutes;
        } catch (e) { return null; }
    }

    function getMap() {
        return window.CampistryGo?._getMap?.() || window._map || null;
    }

    function toast(msg) {
        if (window.CampistryGo?.toast) {
            // Can't access internal toast, use our own
        }
        const el = document.getElementById('toastEl');
        if (el) {
            el.textContent = msg;
            el.className = 'toast';
            requestAnimationFrame(() => {
                el.classList.add('show');
                setTimeout(() => el.classList.remove('show'), 2500);
            });
        }
    }

    function savAndRefresh() {
        // Save to localStorage
        try {
            const store = JSON.parse(localStorage.getItem('campistry_go_data'));
            if (store) {
                localStorage.setItem('campistry_go_data', JSON.stringify(store));
                // Trigger cloud sync
                if (typeof window.saveGlobalSettings === 'function') {
                    window.saveGlobalSettings('campistryGo', store);
                }
            }
        } catch (e) { console.warn('[MapEditor] Save error:', e); }

        // Reload routes and re-render
        // This triggers by dispatching a custom event that campistry_go.js listens to
        window.dispatchEvent(new CustomEvent('campistry-routes-edited'));

        // Fallback: directly call renderMap if available
        setTimeout(() => {
            if (window.CampistryGo?.renderMap) window.CampistryGo.renderMap();
        }, 100);
    }

    // ═══════════════════════════════════════════
    // HOOK INTO EXISTING MAP MARKERS
    // ═══════════════════════════════════════════
    // We override the stop marker click behavior based on current edit mode.
    // The existing renderMap creates markers — we intercept their clicks.

    function hookStopClicks() {
        // Listen for map clicks (for draw mode)
        const map = getMap();
        if (map && !map._metClickHooked) {
            map.on('click', function(e) {
                if (_editMode === 'draw') {
                    handleDrawMapClick(e.latlng);
                }
            });
            map._metClickHooked = true;
        }
    }

    // Expose a function that renderMap can call when creating stop markers
    window._mapEditorStopClick = function(stop, busId, shiftIdx) {
        if (_editMode === 'reorder') { handleReorderClick(stop, busId, shiftIdx); return true; }
        if (_editMode === 'move') { handleMoveClick(stop, busId, shiftIdx); return true; }
        if (_editMode === 'erase') { handleEraseClick(stop, busId, shiftIdx); return true; }
        if (_editMode === 'draw') { handleDrawStopClick(stop, busId, shiftIdx); return true; }
        return false; // select mode — don't intercept
    };

    // ── INIT ──
    function init() {
        injectStyles();
        // Wait for map to be ready
        const check = setInterval(() => {
            if (document.getElementById('routeMap') && document.getElementById('routeMapCard')) {
                clearInterval(check);
                createToolbar();
                hookStopClicks();
                console.log('[Go] Map editor toolbar loaded');
            }
        }, 500);

        // Re-hook after map re-renders
        window.addEventListener('campistry-routes-edited', () => {
            setTimeout(hookStopClicks, 200);
        });
    }

    // Also expose for external access
    window.CampistryGoMapEditor = {
        setEditMode,
        getEditMode: () => _editMode
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
