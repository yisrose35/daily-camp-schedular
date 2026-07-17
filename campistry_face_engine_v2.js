// =============================================================================
// campistry_face_engine_v2.js — modern face engine for Link (arc-512) v2.1
//
// Optional progressive enhancement on top of campistry_face_shared.js:
// loads InsightFace "buffalo_s" ONNX models via onnxruntime-web and provides
//   * PRIMARY DETECTION (detectPrimary): tiled SCRFD det_500m over the working
//     canvas — dramatically stronger than TinyFaceDetector on the small /
//     occluded / crowded faces of group photos (83 vs 64 hard-set AP class)
//   * 512-D ArcFace-class embeddings (describeFaces): w600k MobileFaceNet on
//     5-point-aligned 112x112 crops, tagged model 'arc-512'
//   * runtime: onnxruntime-web — WebGPU when available, WASM fallback
//
// Model loading tries a SELF-HOSTED path first (drop the files under
// models/ — see FACE_RECOGNITION_V2.md) so camp WiFi that blocks CDNs can't
// silently degrade recognition; CDN/HuggingFace is the fallback.
//
// Runs on the main thread AND inside the scan worker (no DOM dependencies —
// canvases come from CampistryFace._makeCanvas).
//
// Everything runs 100% in the browser — no image leaves the device. If this
// engine fails to load, the system continues on faceapi-128 alone.
// =============================================================================
(function () {
    'use strict';
    var GLOBAL = (typeof self !== 'undefined') ? self : window;
    if (GLOBAL.CampistryFaceEngineV2) return;

    var LOCAL_BASE = GLOBAL.CAMPISTRY_MODEL_BASE || 'models';

    var ORT_SRCS = [
        { src: LOCAL_BASE + '/ort/ort.min.js',                                     wasmPath: LOCAL_BASE + '/ort/' },
        { src: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/ort.min.js',
          wasmPath: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/' }
    ];
    // InsightFace ONNX models, maintained + hosted by the Immich project.
    // Detector is ADAPTIVE: WebGPU devices load buffalo_l's det_10g (17MB,
    // ~83 hard-set AP — the strongest open small-face detector) and fall back
    // to buffalo_s det_500m (2.5MB, ~68.5 AP); WASM-only devices go straight
    // to det_500m, where 10g would be too slow per 640px tile.
    var DET_URLS_LARGE = [
        LOCAL_BASE + '/insightface/det_10g.onnx',
        'https://huggingface.co/immich-app/buffalo_l/resolve/main/detection/model.onnx'
    ];
    var DET_URLS_SMALL = [
        LOCAL_BASE + '/insightface/det_500m.onnx',
        'https://huggingface.co/immich-app/buffalo_s/resolve/main/detection/model.onnx'
    ];
    // Recognition is ADAPTIVE + opt-in: when useR50 is enabled (owner setting,
    // WebGPU only), load buffalo_l's ResNet-50 w600k_r50 (~166MB, stronger at
    // separating similar kids) and tag embeddings 'arc-512-r50'. Otherwise the
    // default MobileFaceNet w600k_mbf (13.6MB), tagged 'arc-512'. The two are
    // DIFFERENT vector spaces — switching to r50 means parents re-enroll.
    var REC_URLS_MBF = [
        LOCAL_BASE + '/insightface/w600k_mbf.onnx',
        'https://huggingface.co/immich-app/buffalo_s/resolve/main/recognition/model.onnx'
    ];
    var REC_URLS_R50 = [
        LOCAL_BASE + '/insightface/w600k_r50.onnx',
        'https://huggingface.co/immich-app/buffalo_l/resolve/main/recognition/model.onnx'
    ];
    var _recModelTag = 'arc-512';   // set at init: 'arc-512' (mbf) | 'arc-512-r50'

    var DET_SIZE  = 640;            // SCRFD letterbox input (fixed-shape safe)
    var DET_THRESH = 0.35;          // default confidence floor
    var DET_THRESH_FINE = 0.22;     // lower floor for magnified small-face tiles
                                    // (the per-face re-crop + faceapi re-detect
                                    //  verification stage filters false positives)
    var FINE_TILE = 416;            // small tiles → SCRFD upsizes them to 640,
                                    //  magnifying distant faces ~1.5x so a kid
                                    //  20px across in a field shot becomes ~30px
    var STRIDES   = [8, 16, 32];

    // ArcFace canonical 112x112 5-point template (lm order: left eye, right
    // eye, nose, left mouth corner, right mouth corner)
    var ARC_TEMPLATE = [
        [38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
        [41.5493, 92.3655], [70.7299, 92.2041]
    ];

    var _initPromise = null;
    var _ready = false;
    var _detSession = null, _recSession = null;
    var _ep = null;

    function _face() { return GLOBAL.CampistryFace; }
    function _core() { return GLOBAL.FaceMatchCore; }
    function _makeCanvas(w, h) { return _face()._makeCanvas(w, h); }

    // ─── bootstrap ───────────────────────────────────────────────────────────

    function _createSessionChain(urls, eps) {
        var p = Promise.reject();
        urls.forEach(function (url) {
            p = p.catch(function () {
                return ort.InferenceSession.create(url, {
                    executionProviders: eps,
                    graphOptimizationLevel: 'all'
                });
            });
        });
        return p;
    }

    function init() {
        if (_initPromise) return _initPromise;
        var face = _face();
        if (!face) return Promise.reject(new Error('campistry_face_shared.js not loaded'));

        var wasmPath = null;
        var chain = Promise.reject();
        ORT_SRCS.forEach(function (entry) {
            chain = chain.catch(function () {
                if (typeof ort !== 'undefined') return;         // already loaded
                return face._loadScriptChain([entry.src], function () { return typeof ort !== 'undefined'; })
                    .then(function () { wasmPath = entry.wasmPath; });
            });
        });

        _initPromise = chain.then(function () {
            if (typeof ort === 'undefined') throw new Error('onnxruntime unavailable');
            if (wasmPath) ort.env.wasm.wasmPaths = wasmPath;
            // WebGPU when the environment has it, else WASM (SIMD auto-detected)
            var hasGpu = (typeof navigator !== 'undefined' && navigator.gpu);
            var eps = hasGpu ? ['webgpu', 'wasm'] : ['wasm'];
            _ep = eps[0];
            // adaptive detector: big model on GPU, small on WASM (see DET_URLS_*)
            var detUrls = hasGpu ? DET_URLS_LARGE.concat(DET_URLS_SMALL) : DET_URLS_SMALL;
            // adaptive recognition: r50 only when opted in AND on WebGPU
            // (r50 on WASM would be painfully slow); mbf otherwise
            var wantR50 = hasGpu && !!(GLOBAL.CAMPISTRY_USE_R50);
            _recModelTag = wantR50 ? 'arc-512-r50' : 'arc-512';
            var recUrls = wantR50 ? REC_URLS_R50 : REC_URLS_MBF;
            return Promise.all([_createSessionChain(detUrls, eps), _createSessionChain(recUrls, eps)]);
        }).then(function (sessions) {
            _detSession = sessions[0];
            _recSession = sessions[1];
            _ready = true;
            console.log('[FaceEngineV2] ✅ arc-512 ready (' + _ep + ')');
            return true;
        }).catch(function (e) {
            _initPromise = null;
            _ready = false;
            throw e;
        });
        return _initPromise;
    }

    function isReady() { return _ready; }

    // ─── SCRFD detection ─────────────────────────────────────────────────────

    function _blobFromCanvas(canvas, size, mean, std) {
        // letterbox top-left onto size×size, then NCHW float32 RGB
        var c = _makeCanvas(size, size);
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, size, size);
        var scale = Math.min(size / canvas.width, size / canvas.height);
        var w = Math.round(canvas.width * scale), h = Math.round(canvas.height * scale);
        ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, w, h);
        var data = ctx.getImageData(0, 0, size, size).data;
        var n = size * size;
        var blob = new Float32Array(3 * n);
        for (var i = 0; i < n; i++) {
            blob[i]         = (data[i * 4]     - mean) / std;  // R
            blob[n + i]     = (data[i * 4 + 1] - mean) / std;  // G
            blob[2 * n + i] = (data[i * 4 + 2] - mean) / std;  // B
        }
        return { tensor: new ort.Tensor('float32', blob, [1, 3, size, size]), scale: scale };
    }

    function _squeezeDims(dims) {
        return dims.filter(function (d, i) { return !(i === 0 && d === 1 && dims.length > 2); });
    }

    // Decode SCRFD outputs. Output tensor names vary between exports, so
    // tensors are identified by shape: rows = (size/stride)^2 * 2 anchors,
    // cols = 1 (score) / 4 (bbox) / 10 (keypoints).
    function _decodeScrfd(results, size, thresh) {
        thresh = (thresh == null) ? DET_THRESH : thresh;
        var byRows = {};
        Object.keys(results).forEach(function (name) {
            var t = results[name];
            var dims = _squeezeDims(t.dims);
            if (dims.length !== 2) return;
            var rows = dims[0], cols = dims[1];
            byRows[rows] = byRows[rows] || {};
            if (cols === 1) byRows[rows].score = t.data;
            else if (cols === 4) byRows[rows].bbox = t.data;
            else if (cols === 10) byRows[rows].kps = t.data;
        });

        var dets = [];
        STRIDES.forEach(function (stride) {
            var side = Math.ceil(size / stride);
            var rows = side * side * 2;
            var grp = byRows[rows];
            if (!grp || !grp.score || !grp.bbox) return;
            for (var r = 0; r < rows; r++) {
                var score = grp.score[r];
                if (score < thresh) continue;
                var cell = Math.floor(r / 2);
                var cx = (cell % side) * stride;
                var cy = Math.floor(cell / side) * stride;
                var l = grp.bbox[r * 4] * stride, t = grp.bbox[r * 4 + 1] * stride;
                var rt = grp.bbox[r * 4 + 2] * stride, b = grp.bbox[r * 4 + 3] * stride;
                var det = {
                    score: score,
                    box: { x: cx - l, y: cy - t, width: l + rt, height: t + b },
                    kps: null
                };
                if (grp.kps) {
                    det.kps = [];
                    for (var k = 0; k < 5; k++) {
                        det.kps.push([
                            cx + grp.kps[r * 10 + k * 2] * stride,
                            cy + grp.kps[r * 10 + k * 2 + 1] * stride
                        ]);
                    }
                }
                dets.push(det);
            }
        });
        return dets;
    }

    // All SCRFD detections on a canvas, coords back in canvas space.
    function _detectAll(canvas, thresh) {
        var prep = _blobFromCanvas(canvas, DET_SIZE, 127.5, 128);
        var feeds = {};
        feeds[_detSession.inputNames[0]] = prep.tensor;
        return _detSession.run(feeds).then(function (results) {
            var s = prep.scale;
            return _decodeScrfd(results, DET_SIZE, thresh).map(function (d) {
                return {
                    score: d.score,
                    box: { x: d.box.x / s, y: d.box.y / s, width: d.box.width / s, height: d.box.height / s },
                    kps: d.kps ? d.kps.map(function (p) { return [p[0] / s, p[1] / s]; }) : null
                };
            });
        });
    }

    function _detectBest(canvas) {
        return _detectAll(canvas).then(function (dets) {
            if (!dets.length) return null;
            return dets.reduce(function (a, b) { return b.score > a.score ? b : a; });
        });
    }

    // One tiled pass: cut `work` into `tileSize` tiles, detect each (SCRFD
    // upscales any tile smaller than 640 to 640, magnifying small faces),
    // remap coords back to work space.
    function _tiledPass(work, tileSize, overlap, thresh) {
        var Core = _core();
        var tiles = Core.planTiles(work.width, work.height, tileSize, overlap);
        return Promise.all(tiles.map(function (t) {
            return Promise.resolve().then(function () {
                var tc = _makeCanvas(t.w, t.h);
                tc.getContext('2d').drawImage(work, t.x, t.y, t.w, t.h, 0, 0, t.w, t.h);
                return _detectAll(tc, thresh).then(function (dets) {
                    dets.forEach(function (d) {
                        d.box.x += t.x; d.box.y += t.y;
                        if (d.kps) d.kps = d.kps.map(function (p) { return [p[0] + t.x, p[1] + t.y]; });
                    });
                    return dets;
                });
            });
        })).then(function (arrs) {
            var all = []; arrs.forEach(function (a) { all = all.concat(a); }); return all;
        });
    }

    // PRIMARY detection for CampistryFace: multi-scale tiled SCRFD.
    //   A. whole-image pass — big/near faces
    //   B. coarse 640 tiles — normal group-photo faces
    //   C. FINE 416 tiles, magnified to 640 with a lower threshold — the
    //      distant "kids playing ball from across the field" faces that are
    //      ~20px in the original and invisible to the coarse passes
    // Returns [{box, score, kps}] in work coords (deduped later by the caller).
    function detectPrimary(work, opts) {
        if (!_ready) return Promise.resolve([]);
        var maxSide = Math.max(work.width, work.height);
        var tileOn = !opts || opts.tileThreshold == null || maxSide >= opts.tileThreshold;
        var passes = [_detectAll(work)];
        if (tileOn && maxSide > DET_SIZE) {
            passes.push(_tiledPass(work, DET_SIZE, 0.25, DET_THRESH));
            // fine magnified pass only pays off on genuinely large photos
            // (small uploads have no tiny-face problem to solve)
            if (maxSide >= 1400) {
                passes.push(_tiledPass(work, FINE_TILE, 0.3, DET_THRESH_FINE));
            }
        }
        return Promise.all(passes).then(function (results) {
            var all = [];
            results.forEach(function (dets) { all = all.concat(dets); });
            return Core.nmsMerge(all, 0.45);
        });
    }

    // ─── alignment + embedding ───────────────────────────────────────────────

    // Least-squares non-reflective similarity transform mapping src[i] → dst[i]:
    //   u = a*x - b*y + tx ; v = b*x + a*y + ty
    // Solved via 4x4 normal equations (Gaussian elimination).
    function _similarityTransform(src, dst) {
        var M = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
        var rhs = [0, 0, 0, 0];
        function addRow(row, val) {
            for (var i = 0; i < 4; i++) {
                rhs[i] += row[i] * val;
                for (var j = 0; j < 4; j++) M[i][j] += row[i] * row[j];
            }
        }
        for (var k = 0; k < src.length; k++) {
            var x = src[k][0], y = src[k][1];
            addRow([x, -y, 1, 0], dst[k][0]);
            addRow([y,  x, 0, 1], dst[k][1]);
        }
        // gaussian elimination with partial pivoting
        for (var col = 0; col < 4; col++) {
            var piv = col;
            for (var r2 = col + 1; r2 < 4; r2++) if (Math.abs(M[r2][col]) > Math.abs(M[piv][col])) piv = r2;
            if (Math.abs(M[piv][col]) < 1e-12) return null;
            var tmp = M[col]; M[col] = M[piv]; M[piv] = tmp;
            var tv = rhs[col]; rhs[col] = rhs[piv]; rhs[piv] = tv;
            for (var r3 = col + 1; r3 < 4; r3++) {
                var f = M[r3][col] / M[col][col];
                for (var c3 = col; c3 < 4; c3++) M[r3][c3] -= f * M[col][c3];
                rhs[r3] -= f * rhs[col];
            }
        }
        var z = [0, 0, 0, 0];
        for (var r4 = 3; r4 >= 0; r4--) {
            var s2 = rhs[r4];
            for (var c4 = r4 + 1; c4 < 4; c4++) s2 -= M[r4][c4] * z[c4];
            z[r4] = s2 / M[r4][r4];
        }
        return { a: z[0], b: z[1], tx: z[2], ty: z[3] };
    }

    // Warp a source canvas so kps land on the ArcFace template; returns 112x112.
    function _alignFace(canvas, kps) {
        var T = _similarityTransform(kps, ARC_TEMPLATE);
        if (!T) return null;
        var c = _makeCanvas(112, 112);
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 112, 112);
        // dst = [a -b; b a] * src + t  ⇔  ctx.setTransform(a, b, -b, a, tx, ty)
        ctx.setTransform(T.a, T.b, -T.b, T.a, T.tx, T.ty);
        ctx.drawImage(canvas, 0, 0);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        return c;
    }

    function _embed(aligned) {
        var data = aligned.getContext('2d').getImageData(0, 0, 112, 112).data;
        var n = 112 * 112;
        var blob = new Float32Array(3 * n);
        for (var i = 0; i < n; i++) {
            blob[i]         = (data[i * 4]     - 127.5) / 127.5;
            blob[n + i]     = (data[i * 4 + 1] - 127.5) / 127.5;
            blob[2 * n + i] = (data[i * 4 + 2] - 127.5) / 127.5;
        }
        var feeds = {};
        feeds[_recSession.inputNames[0]] = new ort.Tensor('float32', blob, [1, 3, 112, 112]);
        return _recSession.run(feeds).then(function (results) {
            var out = results[_recSession.outputNames[0]].data;
            // L2-normalize so cosine distances are well-defined
            var norm = 0, j;
            for (j = 0; j < out.length; j++) norm += out[j] * out[j];
            norm = Math.sqrt(norm) || 1;
            var vec = new Array(out.length);
            for (j = 0; j < out.length; j++) vec[j] = out[j] / norm;
            return vec;
        });
    }

    // ─── CampistryFace engine contract ───────────────────────────────────────

    // Add face.descriptors['arc-512'] to each face.
    //   * face.kps present (SCRFD was primary) → align straight from the work
    //     canvas — no extra detection round.
    //   * otherwise → crop around the box, SCRFD the crop for keypoints, align.
    function describeFaces(workCanvas, faces) {
        if (!_ready) return Promise.resolve();
        var chain = Promise.resolve();
        faces.forEach(function (face) {
            chain = chain.then(function () {
                if (face.kps) {
                    var aligned = _alignFace(workCanvas, face.kps);
                    if (!aligned) return;
                    return _embed(aligned).then(function (vec) {
                        face.descriptors[_recModelTag] = vec;
                    }).catch(function (e) {
                        console.warn('[FaceEngineV2] embed failed:', e && e.message);
                    });
                }
                var b = face.workBox || face.box;
                if (!b) return;
                var mx = b.width * 0.5, my = b.height * 0.5;
                var cx = Math.max(0, b.x - mx), cy = Math.max(0, b.y - my);
                var cw = Math.min(workCanvas.width - cx, b.width + 2 * mx);
                var ch = Math.min(workCanvas.height - cy, b.height + 2 * my);
                if (cw < 12 || ch < 12) return;
                // upscale small crops so SCRFD + alignment see enough pixels
                var up = Math.max(1, 160 / Math.min(cw, ch));
                var crop = _makeCanvas(cw * up, ch * up);
                crop.getContext('2d').drawImage(workCanvas, cx, cy, cw, ch, 0, 0, crop.width, crop.height);

                return _detectBest(crop).then(function (det) {
                    if (!det || !det.kps) return;
                    return _alignFace(crop, det.kps);
                }).then(function (aligned) {
                    if (!aligned) return;
                    return _embed(aligned).then(function (vec) {
                        face.descriptors[_recModelTag] = vec;
                    });
                }).catch(function (e) {
                    console.warn('[FaceEngineV2] per-face embed failed:', e && e.message);
                });
            });
        });
        return chain;
    }

    var engine = {
        id: 'arc-512',
        init: init,
        isReady: isReady,
        describeFaces: describeFaces,
        detectPrimary: detectPrimary,
        getExecutionProvider: function () { return _ep; }
    };

    GLOBAL.CampistryFaceEngineV2 = engine;
    function _register() {
        if (GLOBAL.CampistryFace && GLOBAL.CampistryFace.registerEngine) {
            GLOBAL.CampistryFace.registerEngine(engine);
            return true;
        }
        return false;
    }
    if (!_register() && typeof document !== 'undefined') {
        document.addEventListener('DOMContentLoaded', _register);
    }
    console.log('[FaceEngineV2] arc-512 engine registered (lazy — call init() to load models)');
})();
