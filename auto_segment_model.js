// =============================================================================
// auto_segment_model.js — Period-segment data model (Phase 1)
// =============================================================================
// Each (bunk, slotIndex) cell in the auto-builder's schedule output maps to an
// ordered list of sub-activity segments whose durations sum to the period
// length. In Phase 1 every segment array has exactly 1 element, mirroring
// window.scheduleAssignments 1:1 — no behavior change yet. Phase 3 will let the
// packer produce multi-element arrays.
//
// Contract:
//   window.scheduleSegments[bunk][slotIndex] = [segment, ...]
//   segment = {
//     activity, field, startMin, endMin, durationMin,
//     fixed: bool, continuation: bool, _source: <ref to assignment entry>
//   }
//
// Core (scheduler_core_main.js) is NOT touched. This model is owned by the
// auto-builder layer. See memory/project_period_segmentation.md.
// =============================================================================
(function () {
    'use strict';

    const VERSION = '0.1.0';

    if (!window.scheduleSegments) window.scheduleSegments = {};

    function segmentFromAssignment(entry) {
        if (entry == null) return null;
        const startMin = (entry._startMin != null) ? entry._startMin : null;
        const endMin   = (entry._endMin   != null) ? entry._endMin   : null;
        const durationMin = (startMin != null && endMin != null) ? (endMin - startMin) : null;
        return {
            activity: entry._activity || entry.sport || null,
            field:    entry.field || null,
            startMin,
            endMin,
            durationMin,
            fixed:        !!entry._fixed,
            continuation: !!entry.continuation,
            _source:      entry
        };
    }

    function getSegments(bunk, slotIndex) {
        const row = window.scheduleSegments?.[bunk];
        if (!row) return [];
        const cell = row[slotIndex];
        return Array.isArray(cell) ? cell : [];
    }

    function setSegments(bunk, slotIndex, segments) {
        if (!window.scheduleSegments[bunk]) window.scheduleSegments[bunk] = [];
        window.scheduleSegments[bunk][slotIndex] = Array.isArray(segments) ? segments : [];
    }

    function clearSegments(bunk, slotIndex) {
        if (window.scheduleSegments?.[bunk]) {
            window.scheduleSegments[bunk][slotIndex] = [];
        }
    }

    function getPrimarySegment(bunk, slotIndex) {
        const segs = getSegments(bunk, slotIndex);
        return segs.length ? segs[0] : null;
    }

    function isEmpty(bunk, slotIndex) {
        return getSegments(bunk, slotIndex).length === 0;
    }

    function rebuildFromAssignments() {
        const next = {};
        const assignments = window.scheduleAssignments || {};
        for (const bunk of Object.keys(assignments)) {
            const row = assignments[bunk];
            if (!Array.isArray(row)) continue;
            const segRow = new Array(row.length);
            for (let i = 0; i < row.length; i++) {
                const seg = segmentFromAssignment(row[i]);
                segRow[i] = seg ? [seg] : [];
            }
            next[bunk] = segRow;
        }
        window.scheduleSegments = next;
        return next;
    }

    // Return an entry-shaped object (underscore-prefixed fields) from a
    // segment — so renderers and style helpers that expect the scheduleAssignments
    // entry shape work uniformly whether a segment came from a legacy single-
    // activity cell (has _source) or was written fresh by the packer (no _source).
    function toRenderEntry(segment) {
        if (!segment) return null;
        if (segment._source) return segment._source;
        return {
            _activity:   segment.activity,
            sport:       segment.activity,
            field:       segment.field,
            _startMin:   segment.startMin,
            _endMin:     segment.endMin,
            _fixed:      !!segment.fixed,
            continuation:!!segment.continuation,
            _autoMode:   true,
            _autoSolved: true
        };
    }

    window.AutoSegmentModel = {
        VERSION,
        getSegments,
        setSegments,
        clearSegments,
        getPrimarySegment,
        isEmpty,
        rebuildFromAssignments,
        segmentFromAssignment,
        toRenderEntry
    };

    window.addEventListener('campistry-cloud-schedule-loaded', () => {
        try { rebuildFromAssignments(); } catch (e) { console.warn('[AutoSegmentModel] rebuild on load failed:', e); }
    });

    console.log('[AutoSegmentModel] v' + VERSION + ' loaded');
})();
