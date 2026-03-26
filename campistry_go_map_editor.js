// ═══════════════════════════════════════════════════════════════
// MAP EDITOR INTEGRATION v2 — changes to campistry_go.js
// ═══════════════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────
// CHANGE 1: Update the public API object
//
// FIND:
//     closeModal, openModal
// (last line before the closing }; of window.CampistryGo)
//
// REPLACE WITH:
// ─────────────────────────────────────────────────────

        closeModal, openModal,
        _getMap: function() { return _map; },
        _getSavedRoutes: function() { return D.savedRoutes; },
        _setSavedRoutes: function(r) { D.savedRoutes = r; _generatedRoutes = r; },
        _save: function() { save(); },
        _refreshRoutes: function() {
            if (D.savedRoutes) {
                _generatedRoutes = D.savedRoutes;
                _routeGeomCache = {};
                renderRouteResults(applyOverrides(D.savedRoutes));
            }
        },
        _getRouteGeomCache: function() { return _routeGeomCache; },
        _clearGeomCache: function(key) { if (key) delete _routeGeomCache[key]; else _routeGeomCache = {}; }


// ─────────────────────────────────────────────────────
// CHANGE 2: Suppress popups in edit mode + hook clicks
//
// In renderMap(), find:
//     marker.bindPopup(popup);
//     _mapLayers.push(marker);
//
// REPLACE WITH:
// ─────────────────────────────────────────────────────

                marker.bindPopup(popup);
                _mapLayers.push(marker);

                // Map editor integration: intercept clicks in edit mode
                (function(theStop, theBusId, theShiftIdx) {
                    marker.on('click', function(e) {
                        // In edit mode, suppress popup and route to editor
                        if (window._mapEditorStopClick) {
                            const handled = window._mapEditorStopClick(theStop, theBusId, theShiftIdx);
                            if (handled) {
                                marker.closePopup();
                                return;
                            }
                        }
                    });
                })(stop, route.busId, route.shiftIdx);
