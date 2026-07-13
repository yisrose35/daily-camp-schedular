// =============================================================================
// campistry_face_shared.js — shared in-browser face engine for Link (v2.1)
//
// Runs face detection + description entirely IN THE BROWSER. Used by:
//   * the parent portal    → compute reference descriptors for a child's
//                            enrollment photos (front / left / right)
//   * the admin photo tool → scan camp photos (via campistry_link_photos.js)
//
// No biometric image ever leaves the device for compute — only the resulting
// descriptor arrays are persisted (see migrations 028/029).
//
// v2 UPGRADES (research-backed, see FACE_RECOGNITION_V2.md):
//   * Tiled (SAHI-style) detection at full working resolution
//   * Larger detector input (640 whole-image / 512 per tile)
//   * Per-face high-res re-crop for stable landmarks + descriptors
//   * Quality metrics (size / score / blur) feeding FaceMatchCore.qualityTier
//   * Engine registry — campistry_face_engine_v2.js adds 'arc-512' descriptors
//     and, when ready, takes over PRIMARY detection with tiled SCRFD
//
// v2.1: environment-agnostic — the same file runs on the main thread AND
// inside a Web Worker (campistry_face_worker.js) using OffscreenCanvas +
// createImageBitmap, so batch scanning never freezes the admin UI.
// Model loading tries a SELF-HOSTED path first (models/ next to the app —
// drop the files there to survive camp WiFi that blocks CDNs), then the CDN.
//
// Requires face_match_core.js (FaceMatchCore) for tiling/NMS math.
// =============================================================================
(function () {
    'use strict';
    var GLOBAL = (typeof self !== 'undefined') ? self : window;
    if (GLOBAL.CampistryFace) return;

    var IS_WORKER = (typeof importScripts === 'function') && (typeof document === 'undefined');

    // Self-hosted model base (override with self.CAMPISTRY_MODEL_BASE before
    // this script loads). Layout expected:
    //   <base>/face-api/face-api.min.js
    //   <base>/face-api/weights/*             (the justadudewhohacks weight files)
    var LOCAL_BASE = GLOBAL.CAMPISTRY_MODEL_BASE || 'models';

    var FACE_API_SRCS = [
        LOCAL_BASE + '/face-api/face-api.min.js',
        'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/dist/face-api.min.js'
    ];
    // Weights: vladmandic's own /model path serves manifests but NOT the weight
    // shards (404) — it hangs forever. The canonical justadudewhohacks weights are
    // format-compatible with the vladmandic runtime and reliably hosted.
    var WEIGHT_URLS = [
        LOCAL_BASE + '/face-api/weights',
        'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights'
    ];

    var DEFAULTS = {
        maxWorkDim: 2560,      // working-canvas cap: keeps memory bounded but preserves small faces
        tileThreshold: 1100,   // run the tiled pass when the working image exceeds this
        tileSize: 768,
        tileOverlap: 0.25,
        wholeInputSize: 640,   // detector input for the whole-image pass (was 416)
        tileInputSize: 512,    // detector input per tile
        scoreThreshold: 0.3,
        cropMargin: 0.4,       // margin around a detection when re-cropping for descriptor
        cropMinSide: 160       // upscale face crops so landmarks/descriptor get enough pixels
    };

    var _modelsPromise = null;
    var _engines = [];         // registered extra engines (e.g. arc-512)

    // ─── environment-agnostic primitives ────────────────────────────────────

    function _makeCanvas(w, h) {
        if (IS_WORKER || typeof document === 'undefined') {
            return new OffscreenCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
        }
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w));
        c.height = Math.max(1, Math.round(h));
        return c;
    }

    function _loadScriptOnce(src) {
        return new Promise(function (resolve, reject) {
            if (IS_WORKER) {
                try { importScripts(src); resolve(); }
                catch (e) { reject(new Error('script load failed: ' + src)); }
                return;
            }
            var s = document.createElement('script');
            s.src = src; s.onload = resolve;
            s.onerror = function () { s.remove(); reject(new Error('script load failed: ' + src)); };
            document.head.appendChild(s);
        });
    }

    // Try sources in order (self-hosted first, CDN fallback).
    function _loadScriptChain(srcs, check) {
        var p = Promise.reject();
        srcs.forEach(function (src) {
            p = p.catch(function () {
                if (check && check()) return;   // already present
                return _loadScriptOnce(src);
            });
        });
        return p;
    }

    function _withTimeout(promise, ms, label) {
        return new Promise(function (resolve, reject) {
            var done = false;
            var t = setTimeout(function () { if (!done) { done = true; reject(new Error((label || 'operation') + ' timed out')); } }, ms);
            promise.then(function (v) { if (!done) { done = true; clearTimeout(t); resolve(v); } },
                         function (e) { if (!done) { done = true; clearTimeout(t); reject(e); } });
        });
    }

    // Load an image source into something drawable (HTMLImageElement on the
    // main thread, ImageBitmap in a worker). Both expose width/height.
    function _loadImage(src) {
        if (src && (src.tagName === 'IMG' || (typeof ImageBitmap !== 'undefined' && src instanceof ImageBitmap))) {
            return Promise.resolve(src);
        }
        if (IS_WORKER) {
            return fetch(src).then(function (r) { return r.blob(); }).then(function (b) { return createImageBitmap(b); });
        }
        return new Promise(function (resolve, reject) {
            var img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = function () { resolve(img); };
            img.onerror = function () { reject(new Error('image load failed')); };
            img.src = src;
        });
    }

    // toDataURL that works for both canvas kinds (OffscreenCanvas only has
    // convertToBlob).
    function _canvasToDataUrl(canvas, quality) {
        if (typeof canvas.toDataURL === 'function') {
            return Promise.resolve(canvas.toDataURL('image/jpeg', quality || 0.85));
        }
        return canvas.convertToBlob({ type: 'image/jpeg', quality: quality || 0.85 }).then(function (blob) {
            return blob.arrayBuffer().then(function (buf) {
                var bytes = new Uint8Array(buf), bin = '';
                for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
                return 'data:image/jpeg;base64,' + btoa(bin);
            });
        });
    }

    // ─── model loading (self-host first, CDN fallback) ──────────────────────

    function _loadWeights(base) {
        return Promise.all([
            faceapi.nets.tinyFaceDetector.loadFromUri(base),
            faceapi.nets.faceLandmark68TinyNet.loadFromUri(base),
            faceapi.nets.faceRecognitionNet.loadFromUri(base)
        ]);
    }

    // Loads the face-api script + the three models we need. Idempotent.
    // Guarded by a timeout so a stalled CDN surfaces an error instead of a
    // permanent "Analyzing…" hang.
    function ensureModels() {
        if (_modelsPromise) return _modelsPromise;
        _modelsPromise = _withTimeout(
            _loadScriptChain(FACE_API_SRCS, function () { return typeof faceapi !== 'undefined'; }),
            25000, 'face-api download'
        ).then(function () {
            if (typeof faceapi === 'undefined') throw new Error('face-api unavailable');
            var p = Promise.reject();
            WEIGHT_URLS.forEach(function (base) {
                p = p.catch(function () { return _withTimeout(_loadWeights(base), 30000, 'face model download'); });
            });
            return p;
        }).then(function () { return true; })
          .catch(function (e) { _modelsPromise = null; throw e; });
        return _modelsPromise;
    }

    // ─── canvas helpers ──────────────────────────────────────────────────────

    function _toCanvas(img, maxDim) {
        var scale = Math.min(1, (maxDim || DEFAULTS.maxWorkDim) / Math.max(img.width, img.height));
        var canvas = _makeCanvas(img.width * scale, img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        return { canvas: canvas, scale: scale };
    }

    function _cropCanvas(src, x, y, w, h, outW, outH) {
        var c = _makeCanvas(outW || w, outH || h);
        c.getContext('2d').drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
        return c;
    }

    // Downscale an image source to a JPEG data URL no larger than maxDim.
    function makeThumb(src, maxDim, quality) {
        maxDim = maxDim || 400; quality = quality || 0.85;
        return _loadImage(src).then(function (img) {
            var r = _toCanvas(img, maxDim);
            return _canvasToDataUrl(r.canvas, quality);
        });
    }

    // Variance of Laplacian on a small grayscale copy — cheap blur estimate.
    // Higher = sharper. Computed at a fixed 96px scale so the threshold in
    // FaceMatchCore.QUALITY_DEFAULTS means the same thing for every face size.
    function _blurVariance(canvas) {
        try {
            var S = 96;
            var c = _cropCanvas(canvas, 0, 0, canvas.width, canvas.height, S, S);
            var data = c.getContext('2d').getImageData(0, 0, S, S).data;
            var gray = new Float32Array(S * S);
            for (var i = 0; i < S * S; i++) {
                gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
            }
            var sum = 0, sumSq = 0, n = 0;
            for (var y = 1; y < S - 1; y++) {
                for (var x = 1; x < S - 1; x++) {
                    var idx = y * S + x;
                    var lap = -4 * gray[idx] + gray[idx - 1] + gray[idx + 1] + gray[idx - S] + gray[idx + S];
                    sum += lap; sumSq += lap * lap; n++;
                }
            }
            var mean = sum / n;
            return sumSq / n - mean * mean;
        } catch (e) { return null; }  // tainted canvas etc. — treat as unknown
    }

    // ─── detection pipeline ──────────────────────────────────────────────────

    function _tinyOpts(inputSize, score) {
        return new faceapi.TinyFaceDetectorOptions({
            inputSize: inputSize,
            scoreThreshold: score == null ? DEFAULTS.scoreThreshold : score
        });
    }

    // Detect faces on one canvas, return [{box, score}] in that canvas's coords.
    function _detectOn(canvas, inputSize) {
        return faceapi.detectAllFaces(canvas, _tinyOpts(inputSize)).then(function (dets) {
            return (dets || []).map(function (d) {
                return { box: { x: d.box.x, y: d.box.y, width: d.box.width, height: d.box.height }, score: d.score };
            });
        });
    }

    // faceapi primary detection: whole-image pass + SAHI tiles, merged.
    function _detectPrimaryFaceapi(work, o, Core) {
        var passes = [_detectOn(work, o.wholeInputSize)];
        if (Math.max(work.width, work.height) >= o.tileThreshold) {
            var tiles = Core.planTiles(work.width, work.height, o.tileSize, o.tileOverlap);
            tiles.forEach(function (t) {
                passes.push(Promise.resolve().then(function () {
                    var tc = _cropCanvas(work, t.x, t.y, t.w, t.h);
                    return _detectOn(tc, o.tileInputSize).then(function (dets) {
                        dets.forEach(function (d) { d.box.x += t.x; d.box.y += t.y; });
                        return dets;
                    });
                }));
            });
        }
        return Promise.all(passes).then(function (results) {
            var all = [];
            results.forEach(function (dets) { all = all.concat(dets); });
            return Core.nmsMerge(all, 0.45);
        });
    }

    /**
     * Full crowd-aware detection + description pipeline.
     *
     * Primary detection: SCRFD (tiled) when the modern engine is ready — it is
     * dramatically stronger on small/occluded faces — otherwise tiled
     * TinyFaceDetector. Either way every face gets a faceapi-128 descriptor
     * (so legacy galleries keep matching) and, when available, an arc-512 one.
     *
     * @returns {Promise<{faces: Array, imageSize: {w,h}, engineIds: Array}>}
     *   faces: [{ id, box (original coords), score, sizePx, blurVar, tier,
     *             descriptors: {model: [...]}, thumb }]
     */
    function detectFacesForMatching(src, opts) {
        var o = Object.assign({}, DEFAULTS, opts || {});
        var Core = GLOBAL.FaceMatchCore;
        if (!Core) return Promise.reject(new Error('FaceMatchCore not loaded'));

        var img, work, workScale;
        return ensureModels().then(function () {
            return _loadImage(src);
        }).then(function (loaded) {
            img = loaded;
            var r = _toCanvas(img, o.maxWorkDim);
            work = r.canvas; workScale = r.scale;   // work = original * workScale

            var primary = _engines.find(function (e) { return e.isReady && e.isReady() && e.detectPrimary; });
            if (primary) {
                return primary.detectPrimary(work, o).then(function (dets) {
                    // SCRFD can whiff on stylized shots the tiny detector gets
                    // (and vice versa) — if it found nothing, fall back.
                    if (dets && dets.length) return dets;
                    return _detectPrimaryFaceapi(work, o, Core);
                });
            }
            return _detectPrimaryFaceapi(work, o, Core);
        }).then(function (merged) {
            if (typeof o.progress === 'function') o.progress({ phase: 'describe', found: merged.length });
            // Per-face: re-crop at high resolution for the 128-D descriptor +
            // quality metrics (also filters tile/detector false positives).
            var chain = Promise.resolve([]);
            merged.forEach(function (det) {
                chain = chain.then(function (acc) {
                    return _describeCrop(work, workScale, det, o).then(function (face) {
                        if (face) acc.push(face);
                        return acc;
                    });
                });
            });
            return chain;
        }).then(function (faces) {
            faces.forEach(function (f, i) { f.id = 'face_' + i; });
            // Optional modern engine (arc-512): add its descriptors per face.
            var enginePromises = _engines.filter(function (e) { return e.isReady && e.isReady(); })
                .map(function (engine) {
                    return Promise.resolve()
                        .then(function () { return engine.describeFaces(work, faces); })
                        .catch(function (err) {
                            console.warn('[CampistryFace] engine ' + engine.id + ' failed:', err && err.message);
                        });
                });
            return Promise.all(enginePromises).then(function () {
                return {
                    faces: faces,
                    imageSize: { w: img.width, h: img.height },
                    engineIds: ['faceapi-128'].concat(_engines.filter(function (e) { return e.isReady && e.isReady(); }).map(function (e) { return e.id; }))
                };
            });
        });
    }

    // Crop one detection (with margin), re-detect + landmarks + descriptor on
    // the crop, and compute quality. Returns null when the re-detect finds
    // nothing (false-positive filter). If the primary detector supplied 5-point
    // landmarks (SCRFD), they're carried through in work-canvas coords for the
    // arc-512 engine to align from directly.
    function _describeCrop(work, workScale, det, o) {
        var Core = GLOBAL.FaceMatchCore;
        var b = det.box;
        var mx = b.width * o.cropMargin, my = b.height * o.cropMargin;
        var cx = Math.max(0, b.x - mx), cy = Math.max(0, b.y - my);
        var cw = Math.min(work.width - cx, b.width + 2 * mx);
        var ch = Math.min(work.height - cy, b.height + 2 * my);
        if (cw < 12 || ch < 12) return Promise.resolve(null);

        // upscale tiny crops so landmarks + recognition see enough pixels
        var scaleUp = Math.max(1, o.cropMinSide / Math.min(cw, ch));
        var crop = _cropCanvas(work, cx, cy, cw, ch, cw * scaleUp, ch * scaleUp);

        return faceapi
            .detectSingleFace(crop, _tinyOpts(320, 0.25))
            .withFaceLandmarks(true)
            .withFaceDescriptor()
            .then(function (res) {
                if (!res) return null;
                // face box in ORIGINAL image coordinates
                var fb = res.detection.box;
                var origBox = {
                    x: Math.round((cx + fb.x / scaleUp) / workScale),
                    y: Math.round((cy + fb.y / scaleUp) / workScale),
                    width: Math.round(fb.width / scaleUp / workScale),
                    height: Math.round(fb.height / scaleUp / workScale)
                };
                var sizePx = Math.min(origBox.width, origBox.height);
                var blurVar = _blurVariance(crop);
                var face = {
                    box: origBox,
                    workBox: { x: cx + fb.x / scaleUp, y: cy + fb.y / scaleUp, width: fb.width / scaleUp, height: fb.height / scaleUp },
                    kps: det.kps || null,   // work-canvas coords when SCRFD was primary
                    score: Math.max(det.score || 0, res.detection.score || 0),
                    sizePx: sizePx,
                    blurVar: blurVar,
                    descriptors: { 'faceapi-128': Array.from(res.descriptor) },
                    thumb: null
                };
                face.tier = Core.qualityTier({ sizePx: sizePx, detScore: face.score, blurVar: blurVar }, o.quality);
                var thumbCanvas = _cropCanvas(crop, 0, 0, crop.width, crop.height, 96, 96 * crop.height / crop.width);
                return _canvasToDataUrl(thumbCanvas, 0.7)
                    .then(function (t) { face.thumb = t; return face; })
                    .catch(function () { return face; });
            })
            .catch(function () { return null; });
    }

    // ─── enrollment ──────────────────────────────────────────────────────────

    // Detect the single most prominent face and return its descriptors for
    // every active engine. Resolves null if no face is found.
    // Returns { descriptors: {model: [...]}, quality: {sizePx, blurVar, tier} }
    function describeFace(src) {
        return detectFacesForMatching(src, { tileThreshold: Infinity }).then(function (result) {
            if (!result.faces.length) return null;
            // most prominent = largest box
            var best = result.faces.reduce(function (a, b) {
                return (b.box.width * b.box.height > a.box.width * a.box.height) ? b : a;
            });
            return {
                descriptors: best.descriptors,
                quality: { sizePx: best.sizePx, blurVar: best.blurVar, tier: best.tier }
            };
        });
    }

    // ─── engine registry (arc-512 etc.) ──────────────────────────────────────

    // engine = { id, isReady(): bool, init(): Promise,
    //            describeFaces(workCanvas, faces): Promise — adds
    //              face.descriptors[engine.id] to each face it can embed,
    //            detectPrimary(workCanvas, opts)?: Promise<[{box,score,kps}]>
    //              — optional: take over primary detection (tiled SCRFD) }
    function registerEngine(engine) {
        if (!engine || !engine.id) return;
        if (_engines.some(function (e) { return e.id === engine.id; })) return;
        _engines.push(engine);
        console.log('[CampistryFace] engine registered: ' + engine.id);
    }

    function getEngines() { return _engines.slice(); }

    GLOBAL.CampistryFace = {
        ensureModels: ensureModels,
        describeFace: describeFace,
        detectFacesForMatching: detectFacesForMatching,
        makeThumb: makeThumb,
        registerEngine: registerEngine,
        getEngines: getEngines,
        DEFAULTS: DEFAULTS,
        // exposed for the engine + worker
        _makeCanvas: _makeCanvas,
        _loadScriptChain: _loadScriptChain,
        _canvasToDataUrl: _canvasToDataUrl,
        isWorker: IS_WORKER
    };
    console.log('[CampistryFace] shared face helper v2.1 ready (' + (IS_WORKER ? 'worker' : 'main') + ')');
})();
