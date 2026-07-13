// =============================================================================
// campistry_face_worker.js — background face-scan worker for Link
//
// Runs the heavy ML (detection, tiling, embeddings) OFF the main thread so
// the admin console stays responsive while a few-hundred-photo batch scans.
// The main thread (campistry_link_photos.js) keeps the light parts: template
// matching, routing, storage, cloud sync.
//
// Protocol (postMessage):
//   → {type:'init', modelBase?}        loads scripts + models
//   ← {type:'ready', engines:[...]}    or {type:'init_failed', error}
//   → {type:'scan', id, dataUrl, opts}
//   ← {id, ok:true, result:{faces, imageSize, engineIds}}  or {id, ok:false, error}
//
// Requires OffscreenCanvas + createImageBitmap (the main thread feature-checks
// before spawning; anything older just scans inline like before).
// =============================================================================
/* eslint-env worker */
'use strict';

var _initialized = false;

function _initScripts(modelBase) {
    if (_initialized) return;
    if (modelBase) self.CAMPISTRY_MODEL_BASE = modelBase;
    importScripts('face_match_core.js', 'campistry_face_shared.js', 'campistry_face_engine_v2.js');
    _initialized = true;
}

self.onmessage = function (ev) {
    var msg = ev.data || {};

    if (msg.type === 'init') {
        try {
            _initScripts(msg.modelBase);
        } catch (e) {
            self.postMessage({ type: 'init_failed', error: 'script load: ' + (e && e.message) });
            return;
        }
        self.CampistryFace.ensureModels().then(function () {
            // The modern engine is best-effort: report ready either way, the
            // shared pipeline auto-uses it only once it finishes loading.
            var enginePromise = (msg.useEngineV2 === false)
                ? Promise.resolve()
                : self.CampistryFaceEngineV2.init().catch(function (e) {
                      console.log('[FaceWorker] arc-512 unavailable, faceapi-128 only:', e && e.message);
                  });
            // Don't block readiness on the (large) ONNX download — resolve as
            // soon as the base models are up; arc-512 joins mid-batch when done.
            enginePromise.catch(function () {});
            self.postMessage({ type: 'ready', engines: ['faceapi-128'] });
        }).catch(function (e) {
            self.postMessage({ type: 'init_failed', error: 'models: ' + (e && e.message) });
        });
        return;
    }

    if (msg.type === 'scan') {
        if (!_initialized || !self.CampistryFace) {
            self.postMessage({ id: msg.id, ok: false, error: 'worker not initialized' });
            return;
        }
        self.CampistryFace.detectFacesForMatching(msg.dataUrl, msg.opts || {}).then(function (result) {
            // strip non-serializable / unneeded fields before posting
            var faces = (result.faces || []).map(function (f) {
                return {
                    id: f.id, box: f.box, score: f.score,
                    sizePx: f.sizePx, blurVar: f.blurVar, tier: f.tier,
                    descriptors: f.descriptors, thumb: f.thumb
                };
            });
            self.postMessage({ id: msg.id, ok: true, result: { faces: faces, imageSize: result.imageSize, engineIds: result.engineIds } });
        }).catch(function (e) {
            self.postMessage({ id: msg.id, ok: false, error: (e && e.message) || 'scan failed' });
        });
        return;
    }
};

console.log('[FaceWorker] worker booted — waiting for init');
