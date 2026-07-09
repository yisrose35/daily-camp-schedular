// ============================================================================
// generation_trace.js — GENERATION BRAIN TRACE
// ============================================================================
// Records the scheduler's full decision process during a generation run:
//   • every solver narrative line ([AutoCore]/[AutoSolver] log/warn/err)
//   • every rotation score breakdown (recency/streak/frequency/variety/
//     distribution/coverage/limit per bunk+activity+slot)
//   • every hard block and WHY (cooldown, availableDays, maxUsage, cohort,
//     fair-share cap, exact frequency, …)
//   • every ranked candidate list the rotation engine produced
//   • every sport-pick decision (candidates considered, scores, who won)
//
// The trace arms itself automatically around window.runAutoScheduler (and
// window.runScheduler for the manual builder) — no caller changes needed.
//
// CONSOLE API (the user-facing part):
//   downloadGenTrace()        → downloads the latest trace as a JSON file
//   downloadGenTrace(0)       → same (0 = most recent, 1 = one before, …)
//   GenTrace.summary()        → quick stats of the latest trace in console
//   GenTrace.disable() / GenTrace.enable() → kill switch (persisted off? no —
//                               session-only; default is ENABLED)
//
// Memory: entries are capped (see CAPS) with a dropped-counter so a pathological
// run can't blow up the tab. Only the last KEEP_TRACES runs are retained.
// ============================================================================

(function () {
    'use strict';

    const KEEP_TRACES = 3;

    const CAPS = {
        events: 60000,       // solver log lines + generic events
        scores: 40000,       // deduped score breakdowns (bunk|activity|slot)
        blocks: 30000,       // hard-block records
        ranks: 8000,         // ranked candidate lists
        decisions: 12000,    // placement decisions (sport picks etc.)
        rankListLen: 15,     // top-N candidates kept per ranked list
        decisionCands: 10    // top-N candidates kept per decision
    };

    const GenTrace = {
        active: false,
        enabled: true,
        traces: [],          // most recent first
        _cur: null
    };

    function now() { return Date.now(); }

    // ------------------------------------------------------------------ begin
    GenTrace.begin = function (meta) {
        if (!GenTrace.enabled) return;
        if (GenTrace.active) return; // nested generation call — keep outer trace
        GenTrace.active = true;
        GenTrace._cur = {
            meta: Object.assign({
                startedAt: new Date().toISOString(),
                date: (typeof window !== 'undefined' && window.currentScheduleDate) || null,
                url: (typeof location !== 'undefined' && location.pathname) || null
            }, meta || {}),
            _t0: now(),
            result: null,
            events: [],
            scores: {},      // key -> breakdown (latest wins)
            _scoreCount: 0,
            blocks: [],
            ranks: [],
            decisions: [],
            dropped: { events: 0, scores: 0, blocks: 0, ranks: 0, decisions: 0 }
        };
    };

    // -------------------------------------------------------------------- end
    GenTrace.end = function (result) {
        if (!GenTrace.active || !GenTrace._cur) return;
        const tr = GenTrace._cur;
        tr.result = Object.assign({
            endedAt: new Date().toISOString(),
            durationMs: now() - tr._t0
        }, result || {});
        // Snapshot what was ACTUALLY written — the ground truth to compare the
        // scores/decisions against. Compact: one entry per lead slot.
        try {
            const sa = (typeof window !== 'undefined' && window.scheduleAssignments) || null;
            if (sa) {
                const snap = {};
                Object.keys(sa).forEach(function (b) {
                    const arr = sa[b];
                    if (!Array.isArray(arr)) return;
                    snap[b] = arr.map(function (e) {
                        if (!e) return null;
                        if (e.continuation) return 'cont';
                        return { a: e._activity || e.sport || e.field || null, f: e.field || null, s: e._startMin, e: e._endMin };
                    });
                });
                tr.finalSchedule = snap;
            }
        } catch (e) { /* snapshot is best-effort */ }
        tr.counts = {
            events: tr.events.length,
            scores: tr._scoreCount,
            blocks: tr.blocks.length,
            ranks: tr.ranks.length,
            decisions: tr.decisions.length,
            dropped: tr.dropped
        };
        delete tr._t0;
        GenTrace.active = false;
        GenTrace._cur = null;
        GenTrace.traces.unshift(tr);
        while (GenTrace.traces.length > KEEP_TRACES) GenTrace.traces.pop();
        try {
            console.log('%c🧠 [GenTrace] Brain trace captured (' +
                tr.counts.events + ' events, ' + tr.counts.scores + ' score breakdowns, ' +
                tr.counts.blocks + ' blocks, ' + tr.counts.decisions + ' decisions, ' +
                Math.round(tr.result.durationMs / 1000) + 's). Run downloadGenTrace() to save it.',
                'color:#10b981;font-weight:bold;');
        } catch (e) { /* console theming unsupported */ }
    };

    // ------------------------------------------------------------- collectors
    // Solver narrative line ([AutoCore] etc.) — level: 'log'|'warn'|'error'
    GenTrace.solverLog = function (tag, level, msg) {
        const tr = GenTrace._cur;
        if (!GenTrace.active || !tr) return;
        if (tr.events.length >= CAPS.events) { tr.dropped.events++; return; }
        tr.events.push({ t: now() - tr._t0, ch: tag, lv: level, m: String(msg) });
    };

    // Generic structured event
    GenTrace.event = function (channel, message, data) {
        const tr = GenTrace._cur;
        if (!GenTrace.active || !tr) return;
        if (tr.events.length >= CAPS.events) { tr.dropped.events++; return; }
        const rec = { t: now() - tr._t0, ch: channel, m: String(message) };
        if (data !== undefined) rec.d = data;
        tr.events.push(rec);
    };

    // Rotation score breakdown — deduped by bunk|activity|slot, latest wins.
    // rec: {bunk, activity, slot, recency, streak, frequency, variety,
    //       distribution, coverage, limit, total, blocked?, blockReason?}
    GenTrace.score = function (rec) {
        const tr = GenTrace._cur;
        if (!GenTrace.active || !tr || !rec) return;
        const key = rec.bunk + '|' + rec.activity + '|' + (rec.slot == null ? 0 : rec.slot);
        if (!(key in tr.scores)) {
            if (tr._scoreCount >= CAPS.scores) { tr.dropped.scores++; return; }
            tr._scoreCount++;
        }
        tr.scores[key] = rec;
    };

    // Hard block: an activity was made IMPOSSIBLE for a bunk, and why.
    GenTrace.block = function (bunk, activity, reason, detail) {
        const tr = GenTrace._cur;
        if (!GenTrace.active || !tr) return;
        if (tr.blocks.length >= CAPS.blocks) { tr.dropped.blocks++; return; }
        const rec = { t: now() - tr._t0, bunk: bunk, activity: activity, reason: reason };
        if (detail !== undefined && detail !== null) rec.detail = detail;
        tr.blocks.push(rec);
    };

    // Ranked candidate list produced by RotationEngine.getRankedActivities.
    // rec: {bunk, division, slot, ranked:[{name, score}], blocked:[{name, reason}]}
    GenTrace.rank = function (rec) {
        const tr = GenTrace._cur;
        if (!GenTrace.active || !tr || !rec) return;
        if (tr.ranks.length >= CAPS.ranks) { tr.dropped.ranks++; return; }
        if (rec.ranked && rec.ranked.length > CAPS.rankListLen) {
            rec.rankedTruncated = rec.ranked.length - CAPS.rankListLen;
            rec.ranked = rec.ranked.slice(0, CAPS.rankListLen);
        }
        rec.t = now() - tr._t0;
        tr.ranks.push(rec);
    };

    // A concrete placement decision (e.g. findBestSport pick).
    // rec: {kind, bunk, division, window, candidates:[{name, field, score}],
    //       chosen:{name, field}|null, note}
    GenTrace.decision = function (rec) {
        const tr = GenTrace._cur;
        if (!GenTrace.active || !tr || !rec) return;
        if (tr.decisions.length >= CAPS.decisions) { tr.dropped.decisions++; return; }
        if (rec.candidates && rec.candidates.length > CAPS.decisionCands) {
            rec.candidatesTruncated = rec.candidates.length - CAPS.decisionCands;
            rec.candidates = rec.candidates.slice(0, CAPS.decisionCands);
        }
        rec.t = now() - tr._t0;
        tr.decisions.push(rec);
    };

    // --------------------------------------------------------------- controls
    GenTrace.enable = function () { GenTrace.enabled = true; console.log('[GenTrace] enabled'); };
    GenTrace.disable = function () {
        GenTrace.enabled = false;
        if (GenTrace.active) { GenTrace.active = false; GenTrace._cur = null; }
        console.log('[GenTrace] disabled for this session');
    };

    GenTrace.summary = function (idx) {
        const tr = GenTrace.traces[idx || 0];
        if (!tr) { console.log('[GenTrace] no trace captured yet — run a generation first'); return null; }
        console.log('=== GenTrace summary ===');
        console.log('date: ' + tr.meta.date + '  started: ' + tr.meta.startedAt +
            '  duration: ' + (tr.result ? Math.round(tr.result.durationMs / 1000) + 's' : '?'));
        console.log('counts:', tr.counts);
        const reasons = {};
        tr.blocks.forEach(function (b) { reasons[b.reason] = (reasons[b.reason] || 0) + 1; });
        console.log('block reasons:', reasons);
        return tr.counts;
    };

    // --------------------------------------------------------------- download
    function download(idx, pretty) {
        const tr = GenTrace.traces[idx || 0];
        if (!tr) {
            console.warn('[GenTrace] no trace captured yet — run a generation first, then call downloadGenTrace()');
            return false;
        }
        let json;
        try {
            json = pretty ? JSON.stringify(tr, null, 1) : JSON.stringify(tr);
        } catch (e) {
            console.error('[GenTrace] failed to serialize trace:', e);
            return false;
        }
        const stamp = (tr.meta.date || 'unknown-date') + '_' +
            String(tr.meta.startedAt || '').replace(/[:.]/g, '-');
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'campistry-brain-trace_' + stamp + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
        console.log('[GenTrace] downloaded ' + a.download + ' (' + Math.round(json.length / 1024) + ' KB)');
        return true;
    }
    GenTrace.download = download;

    // ------------------------------------------------- auto-arm entry points
    // Wrap generation entry points via accessor properties so the trace starts
    // and ends automatically no matter which module (re)assigns them or in
    // which order scripts load. Re-assignments (pinned-preservation hooks etc.)
    // flow through the setter and get wrapped exactly once each.
    function armEntryPoint(name, kind) {
        let inner = window[name]; // may be undefined pre-load
        function makeWrapper(fn) {
            const wrapped = async function () {
                const outermost = !GenTrace.active;
                if (outermost) {
                    // Compact, size-safe preview of the call arguments (the manual
                    // builder passes large snapshot objects — never inline those).
                    let optsPreview = null;
                    try {
                        const raw = arguments.length > 1 ? arguments[1] : null;
                        const json = JSON.stringify(raw);
                        optsPreview = (json && json.length <= 4096) ? JSON.parse(json) : (json ? '<' + json.length + ' bytes omitted>' : null);
                    } catch (e) {}
                    GenTrace.begin({ entry: name, kind: kind, options: optsPreview, argCount: arguments.length });
                }
                try {
                    const res = await fn.apply(this, arguments);
                    if (outermost) GenTrace.end({ success: res !== false, returned: (typeof res === 'boolean') ? res : undefined });
                    return res;
                } catch (e) {
                    if (outermost) GenTrace.end({ success: false, error: String(e && e.message || e) });
                    throw e;
                }
            };
            wrapped.__genTraceWrapped = true;
            return wrapped;
        }
        try {
            Object.defineProperty(window, name, {
                configurable: true,
                get: function () { return inner; },
                set: function (fn) {
                    if (typeof fn === 'function' && !fn.__genTraceWrapped) {
                        inner = makeWrapper(fn);
                    } else {
                        inner = fn;
                    }
                }
            });
            // Wrap a pre-existing assignment too
            if (typeof inner === 'function' && !inner.__genTraceWrapped) inner = makeWrapper(inner);
        } catch (e) {
            console.warn('[GenTrace] could not arm ' + name + ':', e);
        }
    }

    armEntryPoint('runAutoScheduler', 'auto');           // scheduler_core_auto.js
    armEntryPoint('runSkeletonOptimizer', 'manual');      // scheduler_core_main.js

    // ------------------------------------------------------------------ expose
    window.GenTrace = GenTrace;
    window.downloadGenTrace = function (idx, pretty) { return download(idx, pretty); };

    console.log('[GenTrace] armed — every generation is recorded; run downloadGenTrace() after generating');
})();
