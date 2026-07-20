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
        'faceapi-128':  { metric: 'euclidean', dims: 128, autoDist: 0.45, reviewDist: 0.55 },
        'arc-512':      { metric: 'cosine',    dims: 512, autoDist: 0.58, reviewDist: 0.70 },
        // buffalo_l ResNet-50 recognition — stronger at telling similar kids
        // apart. Separate vector space from mbf 'arc-512' (never cross-matched);
        // slightly tighter thresholds since embeddings are more discriminative.
        'arc-512-r50':  { metric: 'cosine',    dims: 512, autoDist: 0.55, reviewDist: 0.66 }
    };
    // Strongest-first: when a face and a camper share more than one model, the
    // earliest one present wins (a lucky weaker-model score can't override it).
    var MODEL_PREFERENCE = ['arc-512-r50', 'arc-512'];

    // Quality gate defaults. minFacePx is the min box side (in ORIGINAL image
    // pixels) below which a descriptor is too unreliable to auto-tag.
    var QUALITY_DEFAULTS = {
        minFacePx: 36,        // below this: never embed/match ('reject'). Lowered
                              //  from 48 so distant field-shot faces are found +
                              //  reviewable rather than silently dropped
        weakFacePx: 88,       // below this: match, but cap at review ('weak') —
                              //  small faces never auto-tag, they suggest
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

    // Gallery hygiene (NIST IR 8271: weak multi-image fusion RAISES false
    // positives — only clean galleries help). Two passes over one camper's
    // descriptors of one model:
    //   1. dedupe near-identical members (keeps the template from being
    //      dominated by burst-frame repeats) — keeps the LAST of a dupe pair
    //   2. eject outliers: members whose mean distance to the others is both
    //      far in absolute terms and >> the group's typical spread (a wrongly
    //      confirmed face dragging the template sideways)
    // Never prunes below 2 members — with tiny galleries there's no "typical
    // spread" to trust.
    function pruneGallery(descriptors, metric, opts) {
        var o = Object.assign({ dupeDist: 0.05, outlierAbs: 0.9, outlierFactor: 1.8 }, opts || {});
        var list = (descriptors || []).filter(function (d) { return d && d.length; });
        if (!list.length) return list;

        // dedupe (applies at any gallery size)
        var kept = [];
        list.forEach(function (d) {
            var dup = kept.some(function (k) { return distanceFor(metric, d, k) < o.dupeDist; });
            if (dup) return;
            kept.push(d);
        });
        // outlier ejection needs enough members to define a "typical spread"
        if (kept.length <= 2) return kept;

        // outlier ejection
        var meanDists = kept.map(function (d, i) {
            var s = 0, n = 0;
            kept.forEach(function (k, j) { if (i !== j) { s += distanceFor(metric, d, k); n++; } });
            return s / n;
        });
        var sorted = meanDists.slice().sort(function (a, b) { return a - b; });
        var median = sorted[Math.floor(sorted.length / 2)];
        var out = kept.filter(function (d, i) {
            return !(meanDists[i] > o.outlierAbs && meanDists[i] > median * o.outlierFactor);
        });
        return out.length >= 2 ? out : kept;
    }

    // How varied a camper's reference gallery is = mean pairwise distance
    // between its descriptors. A NARROW gallery (all photos look the same:
    // one expression, one look, no glasses variety) is brittle to appearance
    // change; a WIDE gallery spans the kid's real range and matches robustly.
    //   Returns { count, spread, narrow } — spread in the model's distance
    //   units; narrow=true when there's too little variety to trust across
    //   glasses/hair/expression changes.
    function galleryDiversity(descriptors, metric, opts) {
        var o = Object.assign({ narrowBelow: (metric === 'cosine' ? 0.18 : 0.35), minCount: 2 }, opts || {});
        var list = (descriptors || []).filter(function (d) { return d && d.length; });
        if (list.length < o.minCount) return { count: list.length, spread: 0, narrow: true };
        var sum = 0, pairs = 0;
        for (var i = 0; i < list.length; i++) {
            for (var j = i + 1; j < list.length; j++) {
                sum += distanceFor(metric, list[i], list[j]); pairs++;
            }
        }
        var spread = pairs ? sum / pairs : 0;
        return { count: list.length, spread: Math.round(spread * 1000) / 1000, narrow: spread < o.narrowBelow };
    }

    // Build a camper template from enrollment descriptors of ONE model:
    // { mean, all } — see matchDistance. Pass opts.metric to enable gallery
    // pruning (dedupe + outlier ejection); omit for the raw legacy behavior.
    function buildTemplate(descriptors, opts) {
        var valid = (descriptors || []).filter(function (d) { return d && d.length; });
        if (opts && opts.metric) valid = pruneGallery(valid, opts.metric, opts);
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

    // ─── confidence scale ────────────────────────────────────────────────────

    // Human-readable confidence from a raw distance, piecewise-linear so the
    // scale is intuitive across models:
    //   dist 0          → 1.00 (perfect)
    //   dist = autoDist → 0.50 (edge of the engine's auto-tag zone)
    //   dist = reviewDist → 0.00 (edge of consideration)
    // Owner-facing thresholds (auto-accept / auto-reject) operate on this scale.
    function confidenceFor(dist, profile) {
        if (dist == null || !isFinite(dist)) return 0;
        var auto = profile.autoDist, review = profile.reviewDist;
        var c;
        if (dist <= auto) c = 1 - 0.5 * (dist / auto);
        else c = 0.5 * (review - dist) / (review - auto);
        return Math.max(0, Math.min(1, c));
    }

    // Route a review-band suggestion using the owner's dials.
    //   conf >= acceptPct → 'accept' (auto-accept: becomes a real tag)
    //   conf <  rejectPct → 'reject' (auto-reject: silently dropped)
    //   otherwise         → 'review' (human queue)
    function routeConfidence(conf, settings) {
        var accept = (settings && settings.acceptPct != null) ? settings.acceptPct : 1.1;  // 1.1 = never
        var reject = (settings && settings.rejectPct != null) ? settings.rejectPct : -1;   // -1  = never
        if (conf >= accept) return 'accept';
        if (conf < reject) return 'reject';
        return 'review';
    }

    // ─── self-learning calibration ───────────────────────────────────────────

    // Learn owner dials from human review decisions.
    //   samples: [{conf: 0..1, approved: bool}]  (each ~50 bytes — cheap to keep)
    //   opts: { targetPrecision (0.95), maxFalseAccept... , minN (10) }
    // acceptPct = lowest confidence cutoff where everything at-or-above it was
    // approved at >= targetPrecision (so auto-accepting there is safe).
    // rejectPct = highest confidence cutoff where everything below it was
    // approved at <= rejectCeiling (so auto-rejecting there loses little).
    // Returns null when there isn't enough evidence yet.
    function calibrateFromDecisions(samples, opts) {
        var o = Object.assign({ targetPrecision: 0.95, rejectCeiling: 0.10, minN: 10 }, opts || {});
        var valid = (samples || []).filter(function (s) {
            return s && typeof s.conf === 'number' && typeof s.approved === 'boolean';
        });
        if (valid.length < o.minN * 2) return null;

        // Cutoffs may only sit at boundaries between DISTINCT confidence values:
        // a threshold at conf c includes every sample tied at c, so precision
        // must be evaluated over the full tie group, not mid-group.
        var desc = valid.slice().sort(function (a, b) { return b.conf - a.conf; });
        var acceptPct = null, approvedSoFar = 0;
        for (var i = 0; i < desc.length; i++) {
            if (desc[i].approved) approvedSoFar++;
            var n = i + 1;
            var boundary = (i === desc.length - 1) || (desc[i + 1].conf < desc[i].conf - 1e-9);
            if (!boundary || n < o.minN) continue;
            if (approvedSoFar / n >= o.targetPrecision) acceptPct = desc[i].conf;
            else break;  // extending the accept zone further only hurts precision
        }

        var asc = valid.slice().sort(function (a, b) { return a.conf - b.conf; });
        var rejectPct = null; approvedSoFar = 0;
        for (var j = 0; j < asc.length; j++) {
            if (asc[j].approved) approvedSoFar++;
            var m = j + 1;
            var rBoundary = (j === asc.length - 1) || (asc[j + 1].conf > asc[j].conf + 1e-9);
            if (!rBoundary || m < o.minN) continue;
            if (approvedSoFar / m <= o.rejectCeiling) rejectPct = asc[j].conf + 0.001;  // reject strictly below
            else break;
        }

        if (acceptPct == null && rejectPct == null) return null;
        // safety bounds: never learn absurd dials, keep a review band open
        if (acceptPct != null) acceptPct = Math.max(0.05, Math.min(0.95, acceptPct));
        if (rejectPct != null) {
            rejectPct = Math.max(0, Math.min(0.9, rejectPct));
            if (acceptPct != null && rejectPct > acceptPct - 0.05) rejectPct = Math.max(0, acceptPct - 0.05);
        }
        return { acceptPct: acceptPct, rejectPct: rejectPct, n: valid.length };
    }

    // ─── burst clustering ────────────────────────────────────────────────────

    // Group photos shot within gapMs of each other (camera bursts / rapid
    // sequences). photos: [{id, capturedAt (ms epoch)}] → array of id-arrays.
    function burstClusters(photos, gapMs) {
        gapMs = gapMs || 15000;
        var withTime = (photos || []).filter(function (p) { return p && p.capturedAt; })
            .sort(function (a, b) { return a.capturedAt - b.capturedAt; });
        var clusters = [], current = [];
        for (var i = 0; i < withTime.length; i++) {
            if (current.length && withTime[i].capturedAt - withTime[i - 1].capturedAt > gapMs) {
                if (current.length > 1) clusters.push(current);
                current = [];
            }
            current.push(withTime[i].id);
        }
        if (current.length > 1) clusters.push(current);
        return clusters;
    }

    // Similarity of two normalized histograms (torso/clothing descriptors):
    // histogram intersection, 0 (disjoint) … 1 (identical).
    function histogramIntersection(a, b) {
        if (!a || !b || a.length !== b.length) return 0;
        var s = 0;
        for (var i = 0; i < a.length; i++) s += Math.min(a[i], b[i]);
        return s;
    }

    // Propagate confirmed identities across a burst (Apple's "moment" idea):
    // if camper X was confidently matched to a face in one frame, look for the
    // same person in the neighboring frames two ways —
    //   FACE:  unassigned face whose descriptor is very close to the CONFIRMED
    //          face (face-to-face beats face-to-template) → status 'accept'
    //   TORSO: same clothing (histogram intersection ≥ torsoMin) when the face
    //          descriptor is missing/turned away → status 'review' ONLY. Camp
    //          uniforms make clothing ambiguous between kids, so torso evidence
    //          alone never auto-tags — it surfaces a suggestion to a human.
    //   photos: [{ photoId, faces: [{id, descriptors, torso?, tier}],
    //              assignments: [{faceId, camperName, status}] }]  (one burst)
    //   opts: { profiles, propagateFactor (0.8), torsoMin (0.62) }
    // Respects one-camper-per-photo and one-name-per-face.
    function propagateBurstMatches(photos, opts) {
        var profiles = (opts && opts.profiles) || MODEL_PROFILES;
        var factor = (opts && opts.propagateFactor) || 0.8;
        var torsoMin = (opts && opts.torsoMin) || 0.62;

        // anchor faces: confidently assigned (auto or accepted)
        var anchors = [];
        photos.forEach(function (p) {
            var faceById = {};
            (p.faces || []).forEach(function (f) { faceById[f.id] = f; });
            (p.assignments || []).forEach(function (a) {
                if (a.status !== 'auto' && a.status !== 'accept') return;
                var f = faceById[a.faceId];
                if (f && f.descriptors) anchors.push({ camperName: a.camperName, descriptors: f.descriptors, torso: f.torso || null });
            });
        });
        if (!anchors.length) return [];

        var extras = [];
        photos.forEach(function (p) {
            var assignedFaces = {}, assignedCampers = {};
            (p.assignments || []).forEach(function (a) {
                assignedFaces[a.faceId] = true; assignedCampers[a.camperName] = true;
            });
            (p.faces || []).forEach(function (f) {
                if (assignedFaces[f.id] || f.tier === 'reject') return;
                var best = null, torsoBest = null;
                anchors.forEach(function (anchor) {
                    if (assignedCampers[anchor.camperName]) return;
                    // face-to-face path
                    if (f.descriptors) {
                        Object.keys(f.descriptors).forEach(function (model) {
                            var prof = profiles[model];
                            if (!prof || !anchor.descriptors[model] || !f.descriptors[model]) return;
                            var d = distanceFor(prof.metric, f.descriptors[model], anchor.descriptors[model]);
                            if (d > prof.autoDist * factor) return;
                            var norm = d / prof.autoDist;
                            if (!best || norm < best.norm) best = { norm: norm, dist: d, model: model, camperName: anchor.camperName };
                        });
                    }
                    // torso path — same clothing, face inconclusive
                    if (!best && anchor.torso && f.torso) {
                        var sim = histogramIntersection(anchor.torso, f.torso);
                        if (sim >= torsoMin && (!torsoBest || sim > torsoBest.sim)) {
                            // face evidence must not CONTRADICT: if both have a
                            // shared model, the distance can't be beyond review
                            var contradicts = false;
                            if (f.descriptors) {
                                Object.keys(f.descriptors).forEach(function (model) {
                                    var prof = profiles[model];
                                    if (!prof || !anchor.descriptors[model]) return;
                                    if (distanceFor(prof.metric, f.descriptors[model], anchor.descriptors[model]) > prof.reviewDist * 1.15) contradicts = true;
                                });
                            }
                            if (!contradicts) torsoBest = { sim: sim, camperName: anchor.camperName };
                        }
                    }
                });
                if (best) {
                    assignedFaces[f.id] = true; assignedCampers[best.camperName] = true;
                    extras.push({
                        photoId: p.photoId, faceId: f.id, camperName: best.camperName,
                        dist: Math.round(best.dist * 1000) / 1000, model: best.model,
                        status: 'accept', via: 'burst'
                    });
                } else if (torsoBest) {
                    assignedFaces[f.id] = true; assignedCampers[torsoBest.camperName] = true;
                    extras.push({
                        photoId: p.photoId, faceId: f.id, camperName: torsoBest.camperName,
                        torsoSim: Math.round(torsoBest.sim * 100) / 100,
                        status: 'review', via: 'torso'
                    });
                }
            });
        });
        return extras;
    }

    // ─── unknown-face clustering (Apple's second pass, batch-scoped) ─────────

    // Greedy agglomerative clustering of UNMATCHED faces across a batch: the
    // same unknown kid appearing in many photos becomes ONE review item
    // ("seen 6 times — who is this?") instead of six invisible misses.
    //   faces: [{ id, photoId, descriptors, tier, thumb? }]
    //   opts:  { profiles, model ('arc-512' w/ faceapi fallback per face),
    //            linkFactor (0.9 × autoDist), minSize (3) }
    // Returns [{ faceIds, photoIds, count, meanDescriptor, model, thumb }].
    function clusterUnmatched(faces, opts) {
        var profiles = (opts && opts.profiles) || MODEL_PROFILES;
        var linkFactor = (opts && opts.linkFactor) || 0.9;
        var minSize = (opts && opts.minSize) || 3;

        var usable = (faces || []).filter(function (f) {
            return f && f.tier !== 'reject' && f.descriptors &&
                   (f.descriptors['arc-512'] || f.descriptors['faceapi-128']);
        });

        var clusters = [];
        usable.forEach(function (f) {
            var model = f.descriptors['arc-512'] ? 'arc-512' : 'faceapi-128';
            var desc = f.descriptors[model];
            var prof = profiles[model];
            var best = null;
            clusters.forEach(function (c) {
                if (c.model !== model) return;
                var d = distanceFor(prof.metric, desc, c.centroid);
                if (d <= prof.autoDist * linkFactor && (!best || d < best.d)) best = { d: d, c: c };
            });
            if (best) {
                var c = best.c;
                c.members.push(f);
                // incremental centroid update, re-normalized
                var n = c.members.length;
                for (var i = 0; i < c.centroid.length; i++) c.centroid[i] = (c.centroid[i] * (n - 1) + desc[i]) / n;
                c.centroid = l2normalize(c.centroid);
            } else {
                clusters.push({ model: model, centroid: desc.slice(), members: [f] });
            }
        });

        return clusters.filter(function (c) { return c.members.length >= minSize; })
            .map(function (c) {
                return {
                    faceIds: c.members.map(function (m) { return m.id; }),
                    photoIds: c.members.map(function (m) { return m.photoId; }),
                    count: c.members.length,
                    meanDescriptor: l2normalize(c.centroid),
                    model: c.model,
                    thumb: (c.members.find(function (m) { return m.thumb; }) || {}).thumb || null
                };
            })
            .sort(function (a, b) { return b.count - a.count; });
    }

    // ─── EXIF capture time ───────────────────────────────────────────────────

    // Burst clustering needs the moment the shutter fired. file.lastModified
    // is only that for files straight off a camera — photos that detoured
    // through WhatsApp/AirDrop/downloads carry the DOWNLOAD time instead,
    // which either merges a whole upload into one fake burst or splits real
    // ones. This reads DateTimeOriginal from the JPEG's EXIF APP1 segment
    // (pass the first ~128KB as an ArrayBuffer). Returns epoch ms or null.
    function exifCaptureTime(arrayBuffer) {
        try {
            var v = new DataView(arrayBuffer);
            if (v.byteLength < 12 || v.getUint16(0) !== 0xFFD8) return null;   // not a JPEG
            var off = 2;
            while (off + 4 <= v.byteLength) {
                var marker = v.getUint16(off);
                if ((marker & 0xFF00) !== 0xFF00) break;
                if (marker === 0xFFDA) break;                                   // start of image data
                var size = v.getUint16(off + 2);
                if (size < 2) break;
                if (marker === 0xFFE1 && off + 10 <= v.byteLength &&
                    v.getUint32(off + 4) === 0x45786966 && v.getUint16(off + 8) === 0) {  // "Exif\0\0"
                    return _exifTiffDate(v, off + 10);
                }
                off += 2 + size;
            }
        } catch (e) { /* truncated buffer / malformed EXIF — fall through */ }
        return null;
    }

    function _exifTiffDate(v, base) {
        var little = v.getUint16(base) === 0x4949;
        function u16(o) { return v.getUint16(o, little); }
        function u32(o) { return v.getUint32(o, little); }
        if (u16(base + 2) !== 42) return null;

        function findTag(ifdStart, wantTag) {
            var n = u16(ifdStart);
            for (var i = 0; i < n; i++) {
                var e = ifdStart + 2 + i * 12;
                if (u16(e) === wantTag) return e;
            }
            return null;
        }
        function readAscii(entry) {
            var count = u32(entry + 4);
            var valOff = count <= 4 ? entry + 8 : base + u32(entry + 8);
            var s = '';
            for (var i = 0; i < Math.min(count, 19); i++) s += String.fromCharCode(v.getUint8(valOff + i));
            var m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
            if (!m) return null;
            var t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
            return isFinite(t) ? t : null;
        }

        var ifd0 = base + u32(base + 4);
        // preferred: Exif sub-IFD → DateTimeOriginal (0x9003) / CreateDate (0x9004)
        var exifPtr = findTag(ifd0, 0x8769);
        if (exifPtr) {
            var exifIfd = base + u32(exifPtr + 8);
            var d = findTag(exifIfd, 0x9003) || findTag(exifIfd, 0x9004);
            if (d) { var t1 = readAscii(d); if (t1) return t1; }
        }
        // fallback: IFD0 DateTime (0x0132)
        var d0 = findTag(ifd0, 0x0132);
        if (d0) return readAscii(d0);
        return null;
    }

    // ─── measurement (NIST-style: miss rate at an operating point) ───────────

    // Empirical performance of the CURRENT dials against the human-labeled
    // decision log. Precision-at-accept ≈ 1-FPIR analogue for the auto-accept
    // zone; missedBelowReject ≈ FNIR analogue for the auto-reject zone.
    function evalReport(samples, dials) {
        var valid = (samples || []).filter(function (s) {
            return s && typeof s.conf === 'number' && typeof s.approved === 'boolean';
        });
        if (!valid.length) return { n: 0 };
        var accept = dials && dials.acceptPct != null ? dials.acceptPct : 1.1;
        var reject = dials && dials.rejectPct != null ? dials.rejectPct : -1;

        var acc = valid.filter(function (s) { return s.conf >= accept; });
        var rej = valid.filter(function (s) { return s.conf < reject; });
        var mid = valid.length - acc.length - rej.length;

        return {
            n: valid.length,
            // of what the dials would auto-accept, how much did humans approve?
            precisionAtAccept: acc.length ? acc.filter(function (s) { return s.approved; }).length / acc.length : null,
            acceptedShare: acc.length / valid.length,
            // of what the dials would auto-reject, how much was actually real?
            missedBelowReject: rej.length ? rej.filter(function (s) { return s.approved; }).length / rej.length : null,
            rejectedShare: rej.length / valid.length,
            reviewShare: mid / valid.length
        };
    }

    // ─── per-photo assignment ────────────────────────────────────────────────

    // One-to-one assignment of detected faces to campers.
    //   faces:   [{ id, descriptors: {model: vec}, tier }]   (tier from qualityTier)
    //   campers: [{ name, templates: {model: {mean, all}}, strict? }]
    //   opts:    { profiles,            — per-model {metric, autoDist, reviewDist}
    //              preferModels,        — when BOTH sides have one of these, use
    //                                     only it (default ['arc-512']: never let
    //                                     a lucky legacy-128 distance outvote the
    //                                     modern embedding)
    //              strictFactor }       — campers marked strict (young ages have
    //                                     elevated child-child false-match rates,
    //                                     NIST FRVT pt.3) only reach 'auto' at
    //                                     autoDist × strictFactor (default 0.85)
    // Pairs are assigned greedily by ascending normalized distance; each face
    // and each camper used at most once.
    // Returns [{ faceId, camperName, dist, model, status: 'auto'|'review' }].
    function assignFaces(faces, campers, opts) {
        var profiles = (opts && opts.profiles) || MODEL_PROFILES;
        var prefer = (opts && opts.preferModels) || MODEL_PREFERENCE;
        var strictFactor = (opts && opts.strictFactor) || 0.85;
        var pairs = [];

        faces.forEach(function (face) {
            if (!face || face.tier === 'reject' || !face.descriptors) return;
            campers.forEach(function (camper) {
                if (!camper || !camper.templates) return;
                // models both sides share
                var models = Object.keys(face.descriptors).filter(function (m) {
                    return profiles[m] && camper.templates[m] && face.descriptors[m];
                });
                // ORDERED preference: use the single highest-priority model both
                // sides have (r50 > mbf); a weaker model's lucky score can't win.
                // Only when none of the preferred models are shared do we fall
                // back to whatever's left (e.g. faceapi-128).
                var chosen = null;
                for (var pi = 0; pi < prefer.length; pi++) {
                    if (models.indexOf(prefer[pi]) >= 0) { chosen = prefer[pi]; break; }
                }
                if (chosen) models = [chosen];

                var best = null;
                models.forEach(function (model) {
                    var prof = profiles[model], tpl = camper.templates[model];
                    var dist = matchDistance(face.descriptors[model], tpl, prof.metric);
                    if (dist > prof.reviewDist) return;
                    // normalize across metrics so greedy ordering is comparable:
                    // 0 = perfect, 1 = at the review boundary
                    var norm = dist / prof.reviewDist;
                    if (!best || norm < best.norm) {
                        var autoLimit = camper.strict ? prof.autoDist * strictFactor : prof.autoDist;
                        best = { norm: norm, dist: dist, model: model, auto: dist <= autoLimit };
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
        MODEL_PREFERENCE: MODEL_PREFERENCE,
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
        pruneGallery: pruneGallery,
        galleryDiversity: galleryDiversity,
        matchDistance: matchDistance,
        qualityTier: qualityTier,
        assignFaces: assignFaces,
        confidenceFor: confidenceFor,
        routeConfidence: routeConfidence,
        calibrateFromDecisions: calibrateFromDecisions,
        burstClusters: burstClusters,
        propagateBurstMatches: propagateBurstMatches,
        histogramIntersection: histogramIntersection,
        clusterUnmatched: clusterUnmatched,
        evalReport: evalReport,
        exifCaptureTime: exifCaptureTime
    };

    if (typeof window !== 'undefined') {
        window.FaceMatchCore = api;
        if (typeof console !== 'undefined') console.log('[FaceMatchCore] v' + VERSION + ' loaded');
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})();
