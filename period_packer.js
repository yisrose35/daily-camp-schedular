// =============================================================================
// period_packer.js — Bounded subset-sum packer for intra-period segmentation
// =============================================================================
// Given a period length and a pool of candidate activities (pre-expanded, one
// candidate per (activity, duration) pair), enumerate valid packings of
// 1..maxSegments segments whose durations sum exactly to the period length,
// score them, and return the top-N.
//
// Size bounds: 10-min granularity, max 4 segments, typical 2. Search space is
// tiny (dozens of compositions, low-hundreds of assignments per period).
//
// Phase 2: module only — no solver integration. See project_period_segmentation.md.
// =============================================================================
(function () {
    'use strict';

    const VERSION = '0.1.0';

    function defaultScoreFn(packing) {
        let total = 0;
        for (const seg of packing.segments) total += (seg.score || 0);
        return total;
    }

    // Enumerate ordered compositions of `total` into 1..maxParts positive
    // multiples of `step`, each >= minPart. Only include compositions where
    // every part length appears in `validDurations`.
    function enumerateCompositions(total, { maxParts, minPart, step, validDurations }) {
        const results = [];
        const parts = [];

        function recurse(remaining) {
            if (remaining === 0) {
                if (parts.length >= 1) results.push(parts.slice());
                return;
            }
            if (parts.length >= maxParts) return;
            for (const d of validDurations) {
                if (d < minPart) continue;
                if (d > remaining) continue;
                if (d % step !== 0) continue;
                parts.push(d);
                recurse(remaining - d);
                parts.pop();
            }
        }

        recurse(total);
        return results;
    }

    // Given a duration composition like [20, 20], assign a candidate from
    // byDur[20] to each slot. Respect allowRepeat at the activity level.
    function enumerateAssignments(composition, byDur, { allowRepeat, maxPackings }) {
        const out = [];
        const used = new Set();
        const picks = [];

        function recurse(i) {
            if (out.length >= maxPackings) return;
            if (i === composition.length) {
                out.push(picks.slice());
                return;
            }
            const bucket = byDur[composition[i]] || [];
            for (const cand of bucket) {
                if (!allowRepeat && used.has(cand.activity)) continue;
                used.add(cand.activity);
                picks.push(cand);
                recurse(i + 1);
                picks.pop();
                used.delete(cand.activity);
                if (out.length >= maxPackings) return;
            }
        }

        recurse(0);
        return out;
    }

    function bucketByDuration(candidates) {
        const byDur = {};
        for (const c of candidates) {
            const d = c.durationMin;
            if (typeof d !== 'number' || d <= 0) continue;
            if (!byDur[d]) byDur[d] = [];
            byDur[d].push(c);
        }
        return byDur;
    }

    function pack(opts) {
        const {
            periodLengthMin,
            candidates,
            maxSegments = 4,
            minSegmentMin = 10,
            granularityMin = 10,
            allowRepeat = false,
            scoreFn = defaultScoreFn,
            topN = 1,
            maxPackings = 10000
        } = opts || {};

        if (typeof periodLengthMin !== 'number' || periodLengthMin <= 0) {
            throw new Error('PeriodPacker: periodLengthMin must be a positive number');
        }
        if (periodLengthMin % granularityMin !== 0) {
            throw new Error('PeriodPacker: periodLengthMin must be a multiple of granularityMin');
        }
        if (!Array.isArray(candidates) || candidates.length === 0) return [];

        const byDur = bucketByDuration(candidates);
        const validDurations = Object.keys(byDur).map(Number).sort((a, b) => a - b);
        if (validDurations.length === 0) return [];

        const compositions = enumerateCompositions(periodLengthMin, {
            maxParts: maxSegments,
            minPart: minSegmentMin,
            step: granularityMin,
            validDurations
        });

        const packings = [];
        for (const comp of compositions) {
            const assignments = enumerateAssignments(comp, byDur, {
                allowRepeat,
                maxPackings: maxPackings - packings.length
            });
            for (const picks of assignments) {
                const segments = picks.map((cand, i) => ({
                    ...cand,
                    durationMin: comp[i]
                }));
                packings.push({
                    segments,
                    totalMin: periodLengthMin,
                    score: 0
                });
                if (packings.length >= maxPackings) break;
            }
            if (packings.length >= maxPackings) break;
        }

        for (const p of packings) p.score = scoreFn(p);
        packings.sort((a, b) => b.score - a.score);

        return packings.slice(0, topN);
    }

    const api = { VERSION, pack, enumerateCompositions, bucketByDuration };

    if (typeof window !== 'undefined') {
        window.PeriodPacker = api;
        if (typeof console !== 'undefined') console.log('[PeriodPacker] v' + VERSION + ' loaded');
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})();
