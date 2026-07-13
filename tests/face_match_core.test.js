/**
 * Tests for face_match_core.js — the pure matching math behind Link facial
 * recognition v2 (tiling, NMS, mean templates, quality gate, 1:1 assignment).
 *
 * Run with: node --test tests/face_match_core.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const Core = require('../face_match_core.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function box(x, y, w, h) { return { x, y, width: w, height: h }; }

// unit vector along axis i of given dims
function axis(dims, i, sign = 1) {
    const v = new Array(dims).fill(0);
    v[i] = sign;
    return v;
}

// small perturbation of a vector, re-normalized
function near(v, eps = 0.05, at = 1) {
    const out = v.slice();
    out[at] = (out[at] || 0) + eps;
    return Core.l2normalize(out);
}

// ---------------------------------------------------------------------------
// iou / nmsMerge
// ---------------------------------------------------------------------------
describe('iou', () => {
    it('returns 1 for identical boxes', () => {
        assert.strictEqual(Core.iou(box(0, 0, 10, 10), box(0, 0, 10, 10)), 1);
    });
    it('returns 0 for disjoint boxes', () => {
        assert.strictEqual(Core.iou(box(0, 0, 10, 10), box(20, 20, 10, 10)), 0);
    });
    it('computes partial overlap', () => {
        // 5x10 overlap over union 150 = 1/3
        const v = Core.iou(box(0, 0, 10, 10), box(5, 0, 10, 10));
        assert.ok(Math.abs(v - 50 / 150) < 1e-9);
    });
});

describe('nmsMerge', () => {
    it('keeps the highest-score box among duplicates', () => {
        const kept = Core.nmsMerge([
            { box: box(0, 0, 100, 100), score: 0.7, tag: 'lo' },
            { box: box(2, 2, 100, 100), score: 0.9, tag: 'hi' }
        ], 0.45);
        assert.strictEqual(kept.length, 1);
        assert.strictEqual(kept[0].tag, 'hi');
    });
    it('keeps non-overlapping boxes', () => {
        const kept = Core.nmsMerge([
            { box: box(0, 0, 50, 50), score: 0.9 },
            { box: box(200, 200, 50, 50), score: 0.8 },
            { box: box(400, 0, 50, 50), score: 0.7 }
        ]);
        assert.strictEqual(kept.length, 3);
    });
    it('handles adjacent faces in a crowd (small mutual IoU) without merging them', () => {
        // two 40px faces 30px apart — IoU is small, both must survive
        const kept = Core.nmsMerge([
            { box: box(0, 0, 40, 40), score: 0.9 },
            { box: box(30, 0, 40, 40), score: 0.85 }
        ], 0.45);
        assert.strictEqual(kept.length, 2);
    });
});

// ---------------------------------------------------------------------------
// planTiles
// ---------------------------------------------------------------------------
describe('planTiles', () => {
    it('returns a single tile when the image fits', () => {
        const tiles = Core.planTiles(600, 400, 768, 0.25);
        assert.deepStrictEqual(tiles, [{ x: 0, y: 0, w: 600, h: 400 }]);
    });
    it('covers every pixel of a large image', () => {
        const W = 3000, H = 2000, T = 768;
        const tiles = Core.planTiles(W, H, T, 0.25);
        // right/bottom edges must be reachable
        const maxX = Math.max(...tiles.map(t => t.x + t.w));
        const maxY = Math.max(...tiles.map(t => t.y + t.h));
        assert.strictEqual(maxX, W);
        assert.strictEqual(maxY, H);
        // no tile exceeds requested size
        tiles.forEach(t => { assert.ok(t.w <= T && t.h <= T); });
    });
    it('overlaps consecutive tiles', () => {
        const tiles = Core.planTiles(2000, 768, 768, 0.25);
        const xs = [...new Set(tiles.map(t => t.x))].sort((a, b) => a - b);
        for (let i = 1; i < xs.length; i++) {
            assert.ok(xs[i] - xs[i - 1] < 768, 'stride must be smaller than tile (overlap)');
        }
    });
});

// ---------------------------------------------------------------------------
// descriptor math
// ---------------------------------------------------------------------------
describe('meanDescriptor / buildTemplate', () => {
    it('re-normalizes the mean to unit length', () => {
        // two different unit vectors: raw mean has norm < 1
        const m = Core.meanDescriptor([axis(4, 0), axis(4, 1)]);
        const norm = Math.sqrt(m.reduce((s, v) => s + v * v, 0));
        assert.ok(Math.abs(norm - 1) < 1e-9, `expected unit norm, got ${norm}`);
    });
    it('mean of identical vectors is the vector itself', () => {
        const v = Core.l2normalize([1, 2, 3, 4]);
        const m = Core.meanDescriptor([v, v, v]);
        v.forEach((x, i) => assert.ok(Math.abs(m[i] - x) < 1e-9));
    });
    it('buildTemplate returns null with no descriptors', () => {
        assert.strictEqual(Core.buildTemplate([]), null);
        assert.strictEqual(Core.buildTemplate(null), null);
    });
});

describe('matchDistance', () => {
    it('uses the best of mean and individual descriptors', () => {
        const front = axis(8, 0);
        const profile = axis(8, 1);
        const tpl = Core.buildTemplate([front, profile]);
        // probe identical to the profile shot: individual distance is 0,
        // mean distance is > 0 — matchDistance must return the min (0)
        const d = Core.matchDistance(profile, tpl, 'euclidean');
        assert.ok(d < 1e-9, `expected 0, got ${d}`);
    });
    it('returns Infinity for missing template', () => {
        assert.strictEqual(Core.matchDistance(axis(4, 0), null, 'euclidean'), Infinity);
    });
});

describe('cosineDistance', () => {
    it('is 0 for identical directions and 1 for orthogonal', () => {
        assert.ok(Math.abs(Core.cosineDistance([1, 0], [2, 0])) < 1e-9);
        assert.ok(Math.abs(Core.cosineDistance([1, 0], [0, 1]) - 1) < 1e-9);
    });
});

// ---------------------------------------------------------------------------
// quality gate
// ---------------------------------------------------------------------------
describe('qualityTier', () => {
    it('rejects tiny faces', () => {
        assert.strictEqual(Core.qualityTier({ sizePx: 30, detScore: 0.9 }), 'reject');
    });
    it('marks small-but-usable faces weak', () => {
        assert.strictEqual(Core.qualityTier({ sizePx: 60, detScore: 0.9 }), 'weak');
    });
    it('marks blurry faces weak even when large', () => {
        assert.strictEqual(Core.qualityTier({ sizePx: 200, detScore: 0.9, blurVar: 10 }), 'weak');
    });
    it('marks large sharp confident faces good', () => {
        assert.strictEqual(Core.qualityTier({ sizePx: 200, detScore: 0.9, blurVar: 300 }), 'good');
    });
    it('treats unknown blur as acceptable (no false rejects)', () => {
        assert.strictEqual(Core.qualityTier({ sizePx: 200, detScore: 0.9, blurVar: null }), 'good');
    });
});

// ---------------------------------------------------------------------------
// confidence scale + owner routing
// ---------------------------------------------------------------------------
describe('confidenceFor', () => {
    const prof = Core.MODEL_PROFILES['faceapi-128']; // auto 0.45, review 0.55
    it('is 1.0 at distance 0', () => {
        assert.strictEqual(Core.confidenceFor(0, prof), 1);
    });
    it('is 0.5 exactly at the auto boundary', () => {
        assert.ok(Math.abs(Core.confidenceFor(prof.autoDist, prof) - 0.5) < 1e-9);
    });
    it('is 0 at the review boundary and beyond', () => {
        assert.strictEqual(Core.confidenceFor(prof.reviewDist, prof), 0);
        assert.strictEqual(Core.confidenceFor(prof.reviewDist + 0.2, prof), 0);
    });
    it('is monotonically decreasing', () => {
        let prev = 2;
        for (let d = 0; d <= 0.6; d += 0.05) {
            const c = Core.confidenceFor(d, prof);
            assert.ok(c <= prev, `not monotone at d=${d}`);
            prev = c;
        }
    });
});

describe('routeConfidence', () => {
    const dials = { acceptPct: 0.30, rejectPct: 0.15 };
    it('auto-accepts at or above the accept dial', () => {
        assert.strictEqual(Core.routeConfidence(0.30, dials), 'accept');
        assert.strictEqual(Core.routeConfidence(0.9, dials), 'accept');
    });
    it('auto-rejects below the reject dial', () => {
        assert.strictEqual(Core.routeConfidence(0.14, dials), 'reject');
    });
    it('sends the middle band to review', () => {
        assert.strictEqual(Core.routeConfidence(0.2, dials), 'review');
    });
    it('defaults to review when dials are unset', () => {
        assert.strictEqual(Core.routeConfidence(0.99, {}), 'review');
        assert.strictEqual(Core.routeConfidence(0.01, null), 'review');
    });
});

// ---------------------------------------------------------------------------
// self-learning calibration
// ---------------------------------------------------------------------------
describe('calibrateFromDecisions', () => {
    function mk(conf, approved, n) {
        return Array.from({ length: n }, () => ({ conf, approved }));
    }
    it('returns null with too little data', () => {
        assert.strictEqual(Core.calibrateFromDecisions(mk(0.5, true, 5)), null);
    });
    it('learns an accept cutoff where high-confidence suggestions were approved', () => {
        // 20 approvals at conf .6, 20 rejections at conf .1
        const samples = mk(0.6, true, 20).concat(mk(0.1, false, 20));
        const r = Core.calibrateFromDecisions(samples);
        assert.ok(r, 'expected a calibration result');
        assert.ok(r.acceptPct != null && r.acceptPct <= 0.6 && r.acceptPct > 0.1,
            `acceptPct ${r.acceptPct} should sit at/below the approved cluster`);
        assert.ok(r.rejectPct != null && r.rejectPct > 0.1 && r.rejectPct < 0.3,
            `rejectPct ${r.rejectPct} should sit just above the rejected cluster`);
    });
    it('does not learn an accept cutoff when approvals are unreliable', () => {
        // 50/50 approvals everywhere — no confidence level is safe to auto-accept
        const samples = mk(0.6, true, 10).concat(mk(0.6, false, 10))
            .concat(mk(0.2, true, 10)).concat(mk(0.2, false, 10));
        const r = Core.calibrateFromDecisions(samples);
        assert.ok(!r || r.acceptPct == null, 'must not auto-accept on 50% precision');
    });
    it('keeps a gap between accept and reject dials', () => {
        const samples = mk(0.4, true, 30).concat(mk(0.35, false, 30));
        const r = Core.calibrateFromDecisions(samples);
        if (r && r.acceptPct != null && r.rejectPct != null) {
            assert.ok(r.acceptPct - r.rejectPct >= 0.05 - 1e-9);
        }
    });
});

// ---------------------------------------------------------------------------
// burst clustering + propagation
// ---------------------------------------------------------------------------
describe('burstClusters', () => {
    it('groups photos shot seconds apart and splits distant ones', () => {
        const t = 1700000000000;
        const clusters = Core.burstClusters([
            { id: 'a', capturedAt: t },
            { id: 'b', capturedAt: t + 4000 },
            { id: 'c', capturedAt: t + 9000 },
            { id: 'd', capturedAt: t + 600000 } // 10 min later — separate
        ], 15000);
        assert.deepStrictEqual(clusters, [['a', 'b', 'c']]);
    });
    it('ignores photos without capture times', () => {
        assert.deepStrictEqual(Core.burstClusters([{ id: 'x' }, { id: 'y' }]), []);
    });
});

describe('propagateBurstMatches', () => {
    const D = 128;
    const aliceFace = Core.l2normalize(axis(D, 0));
    it('propagates a confirmed identity to a near-identical face in the next frame', () => {
        const photos = [
            {
                photoId: 'p1',
                faces: [{ id: 'f1', tier: 'good', descriptors: { 'faceapi-128': aliceFace } }],
                assignments: [{ faceId: 'f1', camperName: 'Alice A', status: 'auto' }]
            },
            {
                photoId: 'p2',
                faces: [{ id: 'f2', tier: 'weak', descriptors: { 'faceapi-128': near(aliceFace, 0.05) } }],
                assignments: []
            }
        ];
        const extras = Core.propagateBurstMatches(photos);
        assert.strictEqual(extras.length, 1);
        assert.strictEqual(extras[0].photoId, 'p2');
        assert.strictEqual(extras[0].camperName, 'Alice A');
        assert.strictEqual(extras[0].via, 'burst');
    });
    it('never double-tags a camper already assigned in the frame', () => {
        const photos = [
            {
                photoId: 'p1',
                faces: [
                    { id: 'f1', tier: 'good', descriptors: { 'faceapi-128': aliceFace } },
                    { id: 'f2', tier: 'good', descriptors: { 'faceapi-128': near(aliceFace, 0.03) } }
                ],
                assignments: [{ faceId: 'f1', camperName: 'Alice A', status: 'auto' }]
            }
        ];
        // f2 is close to Alice's anchor but Alice is already tagged in p1
        assert.strictEqual(Core.propagateBurstMatches(photos).length, 0);
    });
    it('suggests (review, never accept) a torso-only match for a turned-away kid', () => {
        const shirt = [0.5, 0.3, 0.2, 0];
        const photos = [
            {
                photoId: 'p1',
                faces: [{ id: 'f1', tier: 'good', descriptors: { 'faceapi-128': aliceFace }, torso: shirt }],
                assignments: [{ faceId: 'f1', camperName: 'Alice A', status: 'auto' }]
            },
            {
                photoId: 'p2',
                // no face descriptor at all — kid facing away, only torso visible
                faces: [{ id: 'f2', tier: 'weak', descriptors: {}, torso: [0.48, 0.32, 0.2, 0] }],
                assignments: []
            }
        ];
        const extras = Core.propagateBurstMatches(photos);
        assert.strictEqual(extras.length, 1);
        assert.strictEqual(extras[0].via, 'torso');
        assert.strictEqual(extras[0].status, 'review');
        assert.strictEqual(extras[0].camperName, 'Alice A');
    });

    it('blocks a torso match when face evidence contradicts', () => {
        const shirt = [0.5, 0.3, 0.2, 0];
        const otherKid = Core.l2normalize(axis(D, 9));
        const photos = [
            {
                photoId: 'p1',
                faces: [{ id: 'f1', tier: 'good', descriptors: { 'faceapi-128': aliceFace }, torso: shirt }],
                assignments: [{ faceId: 'f1', camperName: 'Alice A', status: 'auto' }]
            },
            {
                photoId: 'p2',
                // same shirt but the face clearly is NOT Alice
                faces: [{ id: 'f2', tier: 'good', descriptors: { 'faceapi-128': otherKid }, torso: shirt.slice() }],
                assignments: []
            }
        ];
        assert.strictEqual(Core.propagateBurstMatches(photos).length, 0);
    });

    it('does not propagate from far descriptors', () => {
        const photos = [
            {
                photoId: 'p1',
                faces: [{ id: 'f1', tier: 'good', descriptors: { 'faceapi-128': aliceFace } }],
                assignments: [{ faceId: 'f1', camperName: 'Alice A', status: 'auto' }]
            },
            {
                photoId: 'p2',
                faces: [{ id: 'f2', tier: 'good', descriptors: { 'faceapi-128': Core.l2normalize(axis(D, 3)) } }],
                assignments: []
            }
        ];
        assert.strictEqual(Core.propagateBurstMatches(photos).length, 0);
    });
});

// ---------------------------------------------------------------------------
// gallery hygiene
// ---------------------------------------------------------------------------
describe('pruneGallery', () => {
    const D = 32;
    const base = Core.l2normalize(axis(D, 0));
    it('dedupes near-identical members', () => {
        const out = Core.pruneGallery([base, near(base, 0.01), near(base, 0.3, 2)], 'euclidean');
        assert.strictEqual(out.length, 2);
    });
    it('ejects a far outlier from a coherent gallery', () => {
        const gallery = [base, near(base, 0.2, 1), near(base, 0.2, 2), near(base, 0.25, 3),
                         Core.l2normalize(axis(D, 9))]; // orthogonal — a wrong confirmation
        const out = Core.pruneGallery(gallery, 'euclidean');
        assert.strictEqual(out.length, 4);
        // the survivor set must not contain the orthogonal outlier
        out.forEach(d => assert.ok(Core.euclidean(d, base) < 1));
    });
    it('never prunes tiny galleries', () => {
        const two = [base, Core.l2normalize(axis(D, 9))];
        assert.strictEqual(Core.pruneGallery(two, 'euclidean').length, 2);
    });
    it('buildTemplate applies pruning only when metric passed', () => {
        const withDupes = [base, near(base, 0.01)];
        assert.strictEqual(Core.buildTemplate(withDupes).all.length, 2);
        assert.strictEqual(Core.buildTemplate(withDupes, { metric: 'euclidean' }).all.length, 1);
    });
});

// ---------------------------------------------------------------------------
// torso histograms
// ---------------------------------------------------------------------------
describe('histogramIntersection', () => {
    it('is 1 for identical normalized histograms and 0 for disjoint', () => {
        assert.strictEqual(Core.histogramIntersection([0.5, 0.5, 0], [0.5, 0.5, 0]), 1);
        assert.strictEqual(Core.histogramIntersection([1, 0], [0, 1]), 0);
    });
    it('handles mismatched/missing inputs safely', () => {
        assert.strictEqual(Core.histogramIntersection(null, [1]), 0);
        assert.strictEqual(Core.histogramIntersection([1, 0], [1]), 0);
    });
});

// ---------------------------------------------------------------------------
// unknown-face clustering
// ---------------------------------------------------------------------------
describe('clusterUnmatched', () => {
    const D = 128;
    const kidA = Core.l2normalize(axis(D, 0));
    const kidB = Core.l2normalize(axis(D, 5));
    function face(id, photoId, desc, thumb) {
        return { id, photoId, tier: 'good', descriptors: { 'faceapi-128': desc }, thumb: thumb || null };
    }
    it('groups the same unknown kid across photos and skips singletons', () => {
        const faces = [
            face('f1', 'p1', near(kidA, 0.02)),
            face('f2', 'p2', near(kidA, 0.04, 2), 'thumb2'),
            face('f3', 'p3', near(kidA, 0.03, 3)),
            face('f4', 'p4', kidB)   // singleton — dropped by minSize
        ];
        const clusters = Core.clusterUnmatched(faces, { minSize: 3 });
        assert.strictEqual(clusters.length, 1);
        assert.strictEqual(clusters[0].count, 3);
        assert.deepStrictEqual(clusters[0].photoIds.sort(), ['p1', 'p2', 'p3']);
        assert.strictEqual(clusters[0].thumb, 'thumb2');
        assert.strictEqual(clusters[0].model, 'faceapi-128');
        // centroid is normalized
        const n = Math.sqrt(clusters[0].meanDescriptor.reduce((s, v) => s + v * v, 0));
        assert.ok(Math.abs(n - 1) < 1e-6);
    });
    it('keeps different kids in different clusters', () => {
        const faces = [
            face('a1', 'p1', near(kidA, 0.02)), face('a2', 'p2', near(kidA, 0.03, 2)), face('a3', 'p3', near(kidA, 0.02, 3)),
            face('b1', 'p1', near(kidB, 0.02)), face('b2', 'p2', near(kidB, 0.03, 2)), face('b3', 'p3', near(kidB, 0.02, 3))
        ];
        const clusters = Core.clusterUnmatched(faces, { minSize: 3 });
        assert.strictEqual(clusters.length, 2);
    });
    it('ignores rejected-tier faces', () => {
        const faces = [
            { id: 'r1', photoId: 'p1', tier: 'reject', descriptors: { 'faceapi-128': kidA } },
            face('f1', 'p1', kidA), face('f2', 'p2', near(kidA, 0.02))
        ];
        assert.strictEqual(Core.clusterUnmatched(faces, { minSize: 3 }).length, 0);
    });
});

// ---------------------------------------------------------------------------
// eval report
// ---------------------------------------------------------------------------
describe('evalReport', () => {
    it('measures precision at the accept dial and misses below reject', () => {
        const samples = [
            { conf: 0.6, approved: true }, { conf: 0.55, approved: true },
            { conf: 0.5, approved: false },                                   // 1 bad in accept zone
            { conf: 0.2, approved: false }, { conf: 0.05, approved: true }    // 1 real below reject
        ];
        const r = Core.evalReport(samples, { acceptPct: 0.5, rejectPct: 0.1 });
        assert.strictEqual(r.n, 5);
        assert.ok(Math.abs(r.precisionAtAccept - 2 / 3) < 1e-9);
        assert.strictEqual(r.missedBelowReject, 1);       // the 0.05 approved sample
        assert.ok(Math.abs(r.reviewShare - 1 / 5) < 1e-9);
    });
    it('returns n:0 for empty logs', () => {
        assert.deepStrictEqual(Core.evalReport([], {}), { n: 0 });
    });
});

// ---------------------------------------------------------------------------
// assignFaces — the heart of per-photo matching
// ---------------------------------------------------------------------------
describe('assignFaces', () => {
    const D = 128;
    const alice = Core.l2normalize(axis(D, 0));
    const bob = Core.l2normalize(axis(D, 1));

    function campers() {
        return [
            { name: 'Alice A', templates: { 'faceapi-128': Core.buildTemplate([alice]) } },
            { name: 'Bob B', templates: { 'faceapi-128': Core.buildTemplate([bob]) } }
        ];
    }

    it('auto-tags a good close match', () => {
        const faces = [{ id: 'f1', tier: 'good', descriptors: { 'faceapi-128': near(alice, 0.02) } }];
        const out = Core.assignFaces(faces, campers());
        assert.strictEqual(out.length, 1);
        assert.strictEqual(out[0].camperName, 'Alice A');
        assert.strictEqual(out[0].status, 'auto');
    });

    it('never assigns the same camper to two faces in one photo', () => {
        const faces = [
            { id: 'f1', tier: 'good', descriptors: { 'faceapi-128': near(alice, 0.01) } },
            { id: 'f2', tier: 'good', descriptors: { 'faceapi-128': near(alice, 0.03) } }
        ];
        const out = Core.assignFaces(faces, campers());
        const aliceTags = out.filter(o => o.camperName === 'Alice A');
        assert.strictEqual(aliceTags.length, 1);
        // the CLOSER face must win
        assert.strictEqual(aliceTags[0].faceId, 'f1');
    });

    it('never gives one face two names', () => {
        const faces = [{ id: 'f1', tier: 'good', descriptors: { 'faceapi-128': near(alice, 0.02) } }];
        const out = Core.assignFaces(faces, campers());
        assert.strictEqual(out.filter(o => o.faceId === 'f1').length, 1);
    });

    it('routes weak-quality faces to review, never auto', () => {
        const faces = [{ id: 'f1', tier: 'weak', descriptors: { 'faceapi-128': near(alice, 0.02) } }];
        const out = Core.assignFaces(faces, campers());
        assert.strictEqual(out.length, 1);
        assert.strictEqual(out[0].status, 'review');
    });

    it('routes gray-zone distances (between auto and review) to review', () => {
        // craft a probe at euclidean distance ~0.5 from alice: between 0.45 and 0.55
        const probe = Core.l2normalize(alice.map((v, i) => v + (i === 5 ? 0.52 : 0)));
        const d = Core.euclidean(probe, alice);
        assert.ok(d > 0.45 && d < 0.55, `probe distance ${d} not in gray zone`);
        const faces = [{ id: 'f1', tier: 'good', descriptors: { 'faceapi-128': probe } }];
        const out = Core.assignFaces(faces, campers());
        assert.strictEqual(out.length, 1);
        assert.strictEqual(out[0].status, 'review');
    });

    it('drops faces beyond the review threshold entirely', () => {
        const faces = [{ id: 'f1', tier: 'good', descriptors: { 'faceapi-128': bob.map(v => -v) } }];
        const out = Core.assignFaces(faces, [{ name: 'Alice A', templates: { 'faceapi-128': Core.buildTemplate([alice]) } }]);
        assert.strictEqual(out.length, 0);
    });

    it('skips rejected faces', () => {
        const faces = [{ id: 'f1', tier: 'reject', descriptors: { 'faceapi-128': alice.slice() } }];
        assert.strictEqual(Core.assignFaces(faces, campers()).length, 0);
    });

    it('prefers the model with the better normalized distance when both exist', () => {
        const a512 = Core.l2normalize(axis(512, 3));
        const faces = [{
            id: 'f1', tier: 'good',
            descriptors: {
                'faceapi-128': near(alice, 0.6, 7),  // far in 128-D (gray/none)
                'arc-512': near(a512, 0.02)          // near-perfect in 512-D
            }
        }];
        const twoModel = [{
            name: 'Alice A',
            templates: {
                'faceapi-128': Core.buildTemplate([alice]),
                'arc-512': Core.buildTemplate([a512])
            }
        }];
        const out = Core.assignFaces(faces, twoModel);
        assert.strictEqual(out.length, 1);
        assert.strictEqual(out[0].model, 'arc-512');
        assert.strictEqual(out[0].status, 'auto');
    });

    it('marks strict campers review instead of auto at the loose end of the auto zone', () => {
        // craft a distance between autoDist*0.85 (0.3825) and autoDist (0.45)
        const probe = Core.l2normalize(alice.map((v, i) => v + (i === 5 ? 0.43 : 0)));
        const d = Core.euclidean(probe, alice);
        assert.ok(d > 0.3825 && d < 0.45, `probe distance ${d} not in the strict band`);
        const faces = [{ id: 'f1', tier: 'good', descriptors: { 'faceapi-128': probe } }];
        const normal = Core.assignFaces(faces, [{ name: 'Alice A', templates: { 'faceapi-128': Core.buildTemplate([alice]) } }]);
        const strict = Core.assignFaces(faces, [{ name: 'Alice A', strict: true, templates: { 'faceapi-128': Core.buildTemplate([alice]) } }]);
        assert.strictEqual(normal[0].status, 'auto');
        assert.strictEqual(strict[0].status, 'review');
    });

    it('strict campers still auto-tag on very close matches', () => {
        const faces = [{ id: 'f1', tier: 'good', descriptors: { 'faceapi-128': near(alice, 0.02) } }];
        const out = Core.assignFaces(faces, [{ name: 'Alice A', strict: true, templates: { 'faceapi-128': Core.buildTemplate([alice]) } }]);
        assert.strictEqual(out[0].status, 'auto');
    });

    it('restricts to the preferred model when both sides have it (no lucky 128-D outvote)', () => {
        const a512 = Core.l2normalize(axis(512, 3));
        // 128-D says VERY close to Bob, arc-512 says Alice — arc must win
        const faces = [{
            id: 'f1', tier: 'good',
            descriptors: { 'faceapi-128': near(bob, 0.01), 'arc-512': near(a512, 0.02) }
        }];
        const campers2 = [
            { name: 'Alice A', templates: { 'faceapi-128': Core.buildTemplate([alice]), 'arc-512': Core.buildTemplate([a512]) } },
            { name: 'Bob B', templates: { 'faceapi-128': Core.buildTemplate([bob]), 'arc-512': Core.buildTemplate([Core.l2normalize(axis(512, 7))]) } }
        ];
        const out = Core.assignFaces(faces, campers2);
        assert.strictEqual(out[0].camperName, 'Alice A');
        assert.strictEqual(out[0].model, 'arc-512');
    });

    it('matches campers that only have legacy 128-D templates when the face has both models', () => {
        const faces = [{
            id: 'f1', tier: 'good',
            descriptors: { 'faceapi-128': near(alice, 0.02), 'arc-512': Core.l2normalize(axis(512, 9)) }
        }];
        const legacyOnly = [{ name: 'Alice A', templates: { 'faceapi-128': Core.buildTemplate([alice]) } }];
        const out = Core.assignFaces(faces, legacyOnly);
        assert.strictEqual(out.length, 1);
        assert.strictEqual(out[0].camperName, 'Alice A');
    });
});
