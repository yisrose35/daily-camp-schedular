// =============================================================================
// campistry_face_engine_v2.js — modern face embeddings for Link (arc-512)
//
// Optional progressive enhancement on top of campistry_face_shared.js:
// loads InsightFace "buffalo_s" ONNX models via onnxruntime-web and adds a
// 512-D ArcFace-class descriptor to every face the base pipeline detects.
//
//   * detection/keypoints: SCRFD det_500m (2.5MB) — used per-face-crop to get
//     the 5 landmarks needed for proper alignment (the base pipeline already
//     found the faces via tiled TinyFaceDetector; SCRFD here is a landmark +
//     verification stage, so its fixed 640x640 input is fine)
//   * recognition: w600k MobileFaceNet (13.6MB) — 512-D embedding from a
//     5-point-aligned 112x112 crop; +4.5 rank-1 pts over older nets on the
//     low-resolution TinyFace benchmark class of problem
//   * runtime: onnxruntime-web, WebGPU when available, WASM fallback
//
// Everything still runs 100% in the browser — no image leaves the device.
// If anything here fails (old browser, CDN block, no WebGPU+slow WASM), the
// engine simply never becomes ready and the system continues on faceapi-128.
//
// Descriptors are tagged model 'arc-512' and are NEVER cross-matched with the
// legacy 128-D space (see FaceMatchCore.MODEL_PROFILES).
// =============================================================================
(function () {
    'use strict';
    if (window.CampistryFaceEngineV2) return;

    var ORT_SRC   = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/ort.min.js';
    var ORT_WASM  = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/';
    // InsightFace buffalo_s ONNX models, maintained + hosted by the Immich project
    var DET_URL   = 'https://huggingface.co/immich-app/buffalo_s/resolve/main/detection/model.onnx';
    var REC_URL   = 'https://huggingface.co/immich-app/buffalo_s/resolve/main/recognition/model.onnx';

    var DET_SIZE  = 640;            // SCRFD letterbox input (fixed-shape safe)
    var DET_THRESH = 0.35;
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

    // ─── bootstrap ───────────────────────────────────────────────────────────

    function _loadScript(src) {
        return new Promise(function (resolve, reject) {
            if (typeof ort !== 'undefined') { resolve(); return; }
            var s = document.createElement('script');
            s.src = src; s.onload = resolve;
            s.onerror = function () { reject(new Error('onnxruntime-web load failed')); };
            document.head.appendChild(s);
        });
    }

    function _createSession(url, eps) {
        return ort.InferenceSession.create(url, {
            executionProviders: eps,
            graphOptimizationLevel: 'all'
        });
    }

    function init() {
        if (_initPromise) return _initPromise;
        _initPromise = _loadScript(ORT_SRC).then(function () {
            if (typeof ort === 'undefined') throw new Error('onnxruntime unavailable');
            ort.env.wasm.wasmPaths = ORT_WASM;
            // WebGPU when the browser has it, else WASM (SIMD auto-detected)
            var eps = (navigator.gpu ? ['webgpu', 'wasm'] : ['wasm']);
            _ep = navigator.gpu ? 'webgpu' : 'wasm';
            return Promise.all([_createSession(DET_URL, eps), _createSession(REC_URL, eps)]);
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

    // ─── SCRFD detection (per-crop landmark stage) ───────────────────────────

    function _blobFromCanvas(canvas, size, mean, std) {
        // letterbox top-left onto size×size, then NCHW float32 RGB
        var c = document.createElement('canvas');
        c.width = size; c.height = size;
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
    function _decodeScrfd(results, size) {
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
                if (score < DET_THRESH) continue;
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

    // Detect the most confident face (+5 keypoints) on a canvas.
    function _detectBest(canvas) {
        var prep = _blobFromCanvas(canvas, DET_SIZE, 127.5, 128);
        var feeds = {};
        feeds[_detSession.inputNames[0]] = prep.tensor;
        return _detSession.run(feeds).then(function (results) {
            var dets = _decodeScrfd(results, DET_SIZE);
            if (!dets.length) return null;
            var best = dets.reduce(function (a, b) { return b.score > a.score ? b : a; });
            // undo the letterbox scale back to canvas coordinates
            var s = prep.scale;
            best.box = { x: best.box.x / s, y: best.box.y / s, width: best.box.width / s, height: best.box.height / s };
            if (best.kps) best.kps = best.kps.map(function (p) { return [p[0] / s, p[1] / s]; });
            return best;
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
        var c = document.createElement('canvas');
        c.width = 112; c.height = 112;
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

    // For each already-detected face: crop around it (margin), find the 5
    // keypoints with SCRFD on the crop, align to 112x112, embed. Adds
    // face.descriptors['arc-512']. Faces where SCRFD finds nothing keep only
    // their faceapi-128 descriptor.
    function describeFaces(workCanvas, faces) {
        if (!_ready) return Promise.resolve();
        var chain = Promise.resolve();
        faces.forEach(function (face) {
            chain = chain.then(function () {
                var b = face.workBox || face.box;
                if (!b) return;
                var mx = b.width * 0.5, my = b.height * 0.5;
                var cx = Math.max(0, b.x - mx), cy = Math.max(0, b.y - my);
                var cw = Math.min(workCanvas.width - cx, b.width + 2 * mx);
                var ch = Math.min(workCanvas.height - cy, b.height + 2 * my);
                if (cw < 12 || ch < 12) return;
                var crop = document.createElement('canvas');
                // upscale small crops so SCRFD + alignment see enough pixels
                var up = Math.max(1, 160 / Math.min(cw, ch));
                crop.width = Math.round(cw * up); crop.height = Math.round(ch * up);
                crop.getContext('2d').drawImage(workCanvas, cx, cy, cw, ch, 0, 0, crop.width, crop.height);

                return _detectBest(crop).then(function (det) {
                    if (!det || !det.kps) return;
                    return _alignFace(crop, det.kps);
                }).then(function (aligned) {
                    if (!aligned) return;
                    return _embed(aligned).then(function (vec) {
                        face.descriptors['arc-512'] = vec;
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
        getExecutionProvider: function () { return _ep; }
    };

    window.CampistryFaceEngineV2 = engine;
    if (window.CampistryFace && window.CampistryFace.registerEngine) {
        window.CampistryFace.registerEngine(engine);
    } else {
        document.addEventListener('DOMContentLoaded', function () {
            if (window.CampistryFace && window.CampistryFace.registerEngine) {
                window.CampistryFace.registerEngine(engine);
            }
        });
    }
    console.log('[FaceEngineV2] arc-512 engine registered (lazy — call init() to load models)');
})();
