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
