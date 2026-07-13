// =============================================================================
// face_match_core.js — pure matching math for Link facial recognition v2
//
// Zero-DOM, zero-model module: geometry (IoU / NMS / tile planning), descriptor
// math (mean templates, distances), quality gating, and the per-photo
// one-to-one assignment that replaces greedy findBestMatch. Everything here is
// deterministic and unit-tested in tests/face_match_core.test.js — the browser
// pipeline (campistry_face_shared.js) and the matcher (campistry_link_photos.js)
// are thin wrappers around these functions.
//
// Design notes (research-backed, see FACE_RECOGNITION_V2.md):
//   * Templates are dimension-wise MEANS of multiple enrollment descriptors,
//     re-L2-normalized (a raw mean of unit vectors has norm < 1, which would
//     silently shift every distance threshold).
//   * Matching distance is min(distance-to-mean, best distance-to-individual):
//     the mean is robust, individual descriptors rescue extreme poses.
//   * Two thresholds per model: autoDist (tag without review) and reviewDist
//     (suggest for human review). Between them nothing is delivered to parents
//     until a human confirms.
//   * Assignment is one-to-one per photo: a camper appears at most once in a
//     photo and a face gets at most one name (greedy on ascending distance —
//     Hungarian-lite, deterministic).
// =============================================================================
(function () {
    'use strict';

    var VERSION = '1.0.0';

    // Per-model matching profiles. Distances are "lower is better":
    //   faceapi-128 — euclidean distance between ~unit-norm 128-D descriptors.
    //     0.4 same-person typical, 0.6 the classic face-api same/diff boundary.
    //     autoDist is deliberately strict: an auto-tag texts a photo to a parent.
    //   arc-512 — cosine distance (1 - cosine similarity) between L2-normalized
    //     512-D InsightFace w600k embeddings. sim >= 0.42 auto, sim >= 0.30 review.
    var MODEL_PROFILES = {
        'faceapi-128': { metric: 'euclidean', dims: 128, autoDist: 0.45, reviewDist: 0.55 },
        'arc-512':     { metric: 'cosine',    dims: 512, autoDist: 0.58, reviewDist: 0.70 }
    };

    // Quality gate defaults. minFacePx is the min box side (in ORIGINAL image
    // pixels) below which a descriptor is too unreliable to auto-tag.
    var QUALITY_DEFAULTS = {
        minFacePx: 48,        // below this: never embed/match ('reject')
        weakFacePx: 80,       // below this: match, but cap at review ('weak')
        minDetScore: 0.4,     // detector confidence floor for auto-tagging
        minBlurVar: 60        // variance-of-Laplacian floor; lower = blurrier
    };

    // ─── geometry ────────────────────────────────────────────────────────────

    function iou(a, b) {
        var x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
        var x2 = Math.min(a.x + a.width, b.x + b.width);
        var y2 = Math.min(a.y + a.height, b.y + b.height);
        var inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
        if (inter <= 0) return 0;
        var union = a.width * a.height + b.width * b.height - inter;
        return union > 0 ? inter / union : 0;
    }

    // Merge detections from overlapping passes/tiles: keep highest score,
    // drop anything overlapping a kept box above iouThr.
    function nmsMerge(dets, iouThr) {
        iouThr = iouThr == null ? 0.45 : iouThr;
        var sorted = dets.slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
        var kept = [];
        for (var i = 0; i < sorted.length; i++) {
            var d = sorted[i], dup = false;
            for (var j = 0; j < kept.length; j++) {
                if (iou(d.box, kept[j].box) > iouThr) { dup = true; break; }
            }
            if (!dup) kept.push(d);
        }
        return kept;
    }

    // Plan overlapping tiles covering a w×h image (SAHI-style sliced inference).
    // Guarantees full coverage: the last tile in each axis is right/bottom-aligned.
    function planTiles(w, h, tileSize, overlap) {
        tileSize = tileSize || 768;
        overlap = overlap == null ? 0.25 : overlap;
        if (w <= tileSize && h <= tileSize) return [{ x: 0, y: 0, w: w, h: h }];
        var stride = Math.max(1, Math.round(tileSize * (1 - overlap)));
        var xs = [], ys = [], v;
        for (v = 0; v < w - tileSize; v += stride) xs.push(v);
        xs.push(Math.max(0, w - tileSize));
        for (v = 0; v < h - tileSize; v += stride) ys.push(v);
        ys.push(Math.max(0, h - tileSize));
        var tiles = [];
        ys.forEach(function (y) {
            xs.forEach(function (x) {
                tiles.push({ x: x, y: y, w: Math.min(tileSize, w - x), h: Math.min(tileSize, h - y) });
            });
        });
        return tiles;
    }

    // ─── descriptor math ─────────────────────────────────────────────────────

    function l2normalize(v) {
        var n = 0, i;
        for (i = 0; i < v.length; i++) n += v[i] * v[i];
        n = Math.sqrt(n);
        var out = new Array(v.length);
        if (n < 1e-10) { for (i = 0; i < v.length; i++) out[i] = 0; return out; }
        for (i = 0; i < v.length; i++) out[i] = v[i] / n;
        return out;
    }

    // Dimension-wise mean of descriptors, re-normalized to unit length so
    // distance thresholds keep their meaning (mean of unit vectors has norm<1).
    function meanDescriptor(descriptors) {
        if (!descriptors || !descriptors.length) return null;
        var dims = descriptors[0].length;
        var sum = new Array(dims), i, j;
        for (j = 0; j < dims; j++) sum[j] = 0;
        for (i = 0; i < descriptors.length; i++) {
            var d = descriptors[i];
            if (!d || d.length !== dims) continue;
            for (j = 0; j < dims; j++) sum[j] += d[j];
        }
        for (j = 0; j < dims; j++) sum[j] /= descriptors.length;
        return l2normalize(sum);
    }

    function euclidean(a, b) {
        var s = 0;
        for (var i = 0; i < a.length; i++) { var d = a[i] - b[i]; s += d * d; }
        return Math.sqrt(s);
    }

    function cosineDistance(a, b) {
        var dot = 0, na = 0, nb = 0;
        for (var i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
        var denom = Math.sqrt(na) * Math.sqrt(nb);
        if (denom < 1e-10) return 1;
        return 1 - dot / denom;
    }

    function distanceFor(metric, a, b) {
        return metric === 'cosine' ? cosineDistance(a, b) : euclidean(a, b);
    }

    // Build a camper template from enrollment descriptors of ONE model:
    // { mean, all } — see matchDistance.
    function buildTemplate(descriptors) {
        var valid = (descriptors || []).filter(function (d) { return d && d.length; });
        if (!valid.length) return null;
        return { mean: meanDescriptor(valid), all: valid };
    }

    // min(distance to the mean template, best distance to any individual
    // enrollment descriptor). The mean is the robust workhorse; individuals
    // rescue profile shots the mean has averaged away.
    function matchDistance(descriptor, template, metric) {
        if (!descriptor || !template) return Infinity;
        var best = template.mean ? distanceFor(metric, descriptor, template.mean) : Infinity;
        for (var i = 0; i < template.all.length; i++) {
            var d = distanceFor(metric, descriptor, template.all[i]);
            if (d < best) best = d;
        }
        return best;
    }

    // ─── quality gate ────────────────────────────────────────────────────────

    // face: { sizePx, detScore, blurVar } (blurVar optional: variance of
    // Laplacian, null = unknown). Returns 'good' | 'weak' | 'reject'.
    //   reject → do not match at all (descriptor is noise at this size)
    //   weak   → match, but never auto-tag: best result is a review suggestion
    //   good   → eligible for auto-tag
    function qualityTier(face, opts) {
        var o = Object.assign({}, QUALITY_DEFAULTS, opts || {});
        var size = face.sizePx || 0;
        if (size < o.minFacePx) return 'reject';
        var weak = size < o.weakFacePx
            || (face.detScore != null && face.detScore < o.minDetScore)
            || (face.blurVar != null && face.blurVar < o.minBlurVar);
        return weak ? 'weak' : 'good';
    }

    // ─── per-photo assignment ────────────────────────────────────────────────

    // One-to-one assignment of detected faces to campers.
    //   faces:   [{ id, descriptors: {model: vec}, tier }]   (tier from qualityTier)
    //   campers: [{ name, templates: {model: {mean, all}} }]
    //   opts:    { profiles } — per-model {metric, autoDist, reviewDist}
    // A face and camper are compared on every model BOTH sides have; the best
    // (lowest, threshold-scaled) model wins. Pairs are assigned greedily by
    // ascending normalized distance; each face and each camper used at most once.
    // Returns [{ faceId, camperName, dist, model, status: 'auto'|'review' }].
    function assignFaces(faces, campers, opts) {
        var profiles = (opts && opts.profiles) || MODEL_PROFILES;
        var pairs = [];

        faces.forEach(function (face) {
            if (!face || face.tier === 'reject' || !face.descriptors) return;
            campers.forEach(function (camper) {
                if (!camper || !camper.templates) return;
                var best = null;
                Object.keys(face.descriptors).forEach(function (model) {
                    var prof = profiles[model], tpl = camper.templates[model];
                    if (!prof || !tpl || !face.descriptors[model]) return;
                    var dist = matchDistance(face.descriptors[model], tpl, prof.metric);
                    if (dist > prof.reviewDist) return;
                    // normalize across metrics so greedy ordering is comparable:
                    // 0 = perfect, 1 = at the review boundary
                    var norm = dist / prof.reviewDist;
                    if (!best || norm < best.norm) {
                        best = { norm: norm, dist: dist, model: model, auto: dist <= prof.autoDist };
                    }
                });
                if (best) {
                    pairs.push({
                        faceId: face.id, camperName: camper.name,
                        dist: best.dist, norm: best.norm, model: best.model,
                        auto: best.auto && face.tier === 'good'
                    });
                }
            });
        });

        pairs.sort(function (a, b) { return a.norm - b.norm; });
        var usedFaces = {}, usedCampers = {}, out = [];
        pairs.forEach(function (p) {
            if (usedFaces[p.faceId] || usedCampers[p.camperName]) return;
            usedFaces[p.faceId] = true;
            usedCampers[p.camperName] = true;
            out.push({
                faceId: p.faceId, camperName: p.camperName,
                dist: Math.round(p.dist * 1000) / 1000, model: p.model,
                status: p.auto ? 'auto' : 'review'
            });
        });
        return out;
    }

    // ─── public api ──────────────────────────────────────────────────────────

    var api = {
        VERSION: VERSION,
        MODEL_PROFILES: MODEL_PROFILES,
        QUALITY_DEFAULTS: QUALITY_DEFAULTS,
        iou: iou,
        nmsMerge: nmsMerge,
        planTiles: planTiles,
        l2normalize: l2normalize,
        meanDescriptor: meanDescriptor,
        euclidean: euclidean,
        cosineDistance: cosineDistance,
        distanceFor: distanceFor,
        buildTemplate: buildTemplate,
        matchDistance: matchDistance,
        qualityTier: qualityTier,
        assignFaces: assignFaces
    };

    if (typeof window !== 'undefined') {
        window.FaceMatchCore = api;
        if (typeof console !== 'undefined') console.log('[FaceMatchCore] v' + VERSION + ' loaded');
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})();
