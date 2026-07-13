// =============================================================================
// campistry_face_shared.js — tiny shared face-api.js helper
//
// One job: turn an image into a 128-float face descriptor (and a small thumbnail)
// entirely IN THE BROWSER. Used by:
//   * the parent portal   → compute a child's reference headshot descriptor
//   * the admin photo tool → (via campistry_link_photos.js) scan camp photos
//
// No biometric image ever leaves the device for compute — only the resulting
// descriptor array is persisted (see migration 028).
// =============================================================================
(function () {
    'use strict';
    if (window.CampistryFace) return;

    var FACE_API_SRC = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/dist/face-api.min.js';
    var MODEL_URL    = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model';

    var _modelsPromise = null;

    function _loadScript(src) {
        return new Promise(function (resolve, reject) {
            if (typeof faceapi !== 'undefined') { resolve(); return; }
            var s = document.createElement('script');
            s.src = src; s.onload = resolve; s.onerror = function () { reject(new Error('face-api load failed')); };
            document.head.appendChild(s);
        });
    }

    // Loads the face-api script + the three models we need. Idempotent.
    function ensureModels() {
        if (_modelsPromise) return _modelsPromise;
        _modelsPromise = _loadScript(FACE_API_SRC).then(function () {
            if (typeof faceapi === 'undefined') throw new Error('face-api unavailable');
            return Promise.all([
                faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
                faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
                faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
            ]);
        }).then(function () { return true; })
          .catch(function (e) { _modelsPromise = null; throw e; });
        return _modelsPromise;
    }

    function _loadImage(src) {
        return new Promise(function (resolve, reject) {
            var img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = function () { resolve(img); };
            img.onerror = function () { reject(new Error('image load failed')); };
            img.src = src;
        });
    }

    // Downscale an image source to a JPEG data URL no larger than maxDim.
    function makeThumb(src, maxDim, quality) {
        maxDim = maxDim || 400; quality = quality || 0.85;
        return _loadImage(src).then(function (img) {
            var scale = Math.min(1, maxDim / Math.max(img.width, img.height));
            var canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(img.width * scale));
            canvas.height = Math.max(1, Math.round(img.height * scale));
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            return canvas.toDataURL('image/jpeg', quality);
        });
    }

    // Detect the single most prominent face and return its 128-float descriptor
    // as a plain Array (jsonb-friendly). Resolves null if no face is found.
    function describeFace(src) {
        return ensureModels().then(function () {
            return _loadImage(src);
        }).then(function (img) {
            return faceapi
                .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.3 }))
                .withFaceLandmarks(true)
                .withFaceDescriptor();
        }).then(function (det) {
            if (!det) return null;
            return Array.from(det.descriptor);
        });
    }

    window.CampistryFace = {
        ensureModels: ensureModels,
        describeFace: describeFace,
        makeThumb: makeThumb
    };
    console.log('[CampistryFace] shared face helper ready');
})();
