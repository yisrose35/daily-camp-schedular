/* =========================================================================
 * Scheduler Audit — paste into the browser console (or load via <script>)
 *
 * Usage:
 *   1. Open DevTools → Console
 *   2. Load this script (either paste or include via <script>)
 *   3. SchedulerAudit.start()          ← call before clicking generate
 *   4. Click Generate in the UI
 *   5. SchedulerAudit.report()         ← shows everything I need to see
 *
 * Alternate entry points:
 *   SchedulerAudit.bunk('36')          per-bunk breakdown
 *   SchedulerAudit.walls()             configured walls + layer dMin values
 *   SchedulerAudit.issues()            just the failures
 *   SchedulerAudit.logs('DUR-FLEX')    filter captured logs by substring
 *
 * What this captures:
 *   - Every [Phase2.5] / [Phase3] / [REBAL] / [PLACEMENT-STUCK] /
 *     [REBAL-STUCK] / [DUR-FLEX] / [SPECIAL-ENFORCE] line during generation
 *   - Post-generation scan of window.bunkTimelines for:
 *       ▸ sub-dMin sport/slot blocks (smoking gun)
 *       ▸ gap structure (where walls sit + what's between them)
 *       ▸ each sub-dMin block's _source, neighbors, and why rebalance failed
 *   - Layer configuration snapshot (layer dMin/dMax per grade)
 *
 * Output is both printed AND attached to window.SchedulerAudit._last so you
 * can copy-paste a JSON blob for me to analyze.
 * ========================================================================= */

(function () {
    'use strict';

    const _state = {
        capturing: false,
        logs: [],                       // { level, ts, text }
        origLog: null,
        origWarn: null,
        origError: null,
        startedAt: null,
        stoppedAt: null,
    };

    const SUBSTR_FILTERS = [
        '[Phase2.5]', '[Phase3]', '[REBAL]', '[REBAL-STUCK]', '[PLACEMENT-STUCK]',
        '[DUR-FLEX]', 'DUR-FLEX', 'SPECIAL-ENFORCE', '[GlobalPlanner]', 'GP]',
        'ENFORCE', '[HOOK]', 'auto-build', 'AutoCore',
    ];

    function matchesFilter(text) {
        const t = String(text);
        for (const s of SUBSTR_FILTERS) if (t.indexOf(s) >= 0) return true;
        return false;
    }

    function flat(args) {
        try {
            return args.map(a =>
                typeof a === 'string' ? a
                    : (a === null || a === undefined) ? String(a)
                        : (typeof a === 'object') ? JSON.stringify(a)
                            : String(a)
            ).join(' ');
        } catch (_) { return String(args); }
    }

    function installHook() {
        if (_state.origLog) return;
        _state.origLog = console.log.bind(console);
        _state.origWarn = console.warn.bind(console);
        _state.origError = console.error.bind(console);
        console.log = function (...args) {
            if (_state.capturing) {
                const text = flat(args);
                if (matchesFilter(text)) _state.logs.push({ level: 'log', ts: Date.now(), text });
            }
            _state.origLog(...args);
        };
        console.warn = function (...args) {
            if (_state.capturing) {
                const text = flat(args);
                _state.logs.push({ level: 'warn', ts: Date.now(), text });
            }
            _state.origWarn(...args);
        };
        console.error = function (...args) {
            if (_state.capturing) {
                const text = flat(args);
                _state.logs.push({ level: 'error', ts: Date.now(), text });
            }
            _state.origError(...args);
        };
    }

    function uninstallHook() {
        if (!_state.origLog) return;
        console.log = _state.origLog;
        console.warn = _state.origWarn;
        console.error = _state.origError;
        _state.origLog = _state.origWarn = _state.origError = null;
    }

    // ---- helpers -----------------------------------------------------------
    const c = {
        ok: (...a) => console.log('%c ✓ ', 'background:#1b5e20;color:#fff;border-radius:3px', ...a),
        bad: (...a) => console.log('%c ✗ ', 'background:#b71c1c;color:#fff;border-radius:3px', ...a),
        warn: (...a) => console.log('%c ⚠ ', 'background:#ef6c00;color:#fff;border-radius:3px', ...a),
        info: (...a) => console.log('%c i ', 'background:#0d47a1;color:#fff;border-radius:3px', ...a),
        h1: (s) => console.log('\n%c' + s + ' ', 'font-size:14px;font-weight:bold;background:#222;color:#fff;padding:4px 8px;border-radius:4px'),
        h2: (s) => console.log('%c' + s, 'font-weight:bold;color:#0d47a1;border-bottom:1px solid #0d47a1'),
    };

    function minToTime(m) {
        if (m == null || isNaN(m)) return '?';
        const h = Math.floor(m / 60);
        const mm = m % 60;
        const hh = ((h + 11) % 12) + 1;
        const ap = h < 12 ? 'AM' : 'PM';
        return `${hh}:${String(mm).padStart(2, '0')}${ap}`;
    }

    function blockSummary(b) {
        if (!b) return 'none';
        const t = (b.type || '').toLowerCase();
        const ev = b.event || b._assignedSport || b._assignedSpecial || '';
        const dur = (b.endMin || 0) - (b.startMin || 0);
        const pinned = b._fixed || b._classification === 'pinned' || ['league', 'specialty_league', 'lunch', 'dismissal'].includes(t);
        return `${t}/${ev} ${minToTime(b.startMin)}-${minToTime(b.endMin)} ${dur}min${pinned ? ' [pinned]' : ''}`;
    }

    function allBunks() {
        return Object.keys(window.bunkTimelines || {}).sort();
    }

    function layerConfig() {
        // Pull whatever layer info we can from the globals
        const divisions = window.divisions || {};
        const out = {};
        Object.keys(divisions).forEach(grade => {
            const d = divisions[grade] || {};
            const layers = [];
            (d.layers || []).forEach(l => {
                layers.push({
                    type: l.type,
                    event: l.event || l.name,
                    dMin: l.durationMin || l.periodMin || l.duration || null,
                    dMax: l.durationMax || l.duration || null,
                    windowStart: l.startMin != null ? minToTime(l.startMin) : null,
                    windowEnd: l.endMin != null ? minToTime(l.endMin) : null,
                });
            });
            out[grade] = {
                start: d.startTime,
                end: d.endTime,
                layers,
            };
        });
        return out;
    }

    function resolveSportDMin(grade) {
        const divisions = window.divisions || {};
        const d = divisions[grade];
        if (!d || !d.layers) return 30; // default guess
        const sportLayer = d.layers.find(l => (l.type || '').toLowerCase() === 'sport' || (l.type || '').toLowerCase() === 'sports');
        if (sportLayer) return sportLayer.durationMin || sportLayer.periodMin || 30;
        return 30;
    }

    function bunkGrade(bunkId) {
        const divisions = window.divisions || {};
        for (const [grade, d] of Object.entries(divisions)) {
            if ((d.bunks || []).map(String).includes(String(bunkId))) return grade;
        }
        return null;
    }

    function scanSubDMinBlocks() {
        const out = [];
        const timelines = window.bunkTimelines || {};
        for (const bunk of allBunks()) {
            const tl = (timelines[bunk] || []).slice().sort((a, b) => a.startMin - b.startMin);
            const grade = bunkGrade(bunk);
            const sportDMin = resolveSportDMin(grade);
            for (let i = 0; i < tl.length; i++) {
                const b = tl[i];
                const t = (b.type || '').toLowerCase();
                if (!['sport', 'slot'].includes(t)) continue;
                const dur = b.endMin - b.startMin;
                if (dur >= sportDMin) continue;
                out.push({
                    bunk, grade,
                    block: blockSummary(b),
                    dur, sportDMin, deficit: sportDMin - dur,
                    source: b._source || '?',
                    event: b.event || b._assignedSport || '',
                    prev: blockSummary(tl[i - 1]),
                    next: blockSummary(tl[i + 1]),
                    prevPinned: !!(tl[i - 1] && (tl[i - 1]._fixed || tl[i - 1]._classification === 'pinned' || ['league', 'specialty_league', 'lunch', 'dismissal'].includes((tl[i - 1].type || '').toLowerCase()))),
                    nextPinned: !!(tl[i + 1] && (tl[i + 1]._fixed || tl[i + 1]._classification === 'pinned' || ['league', 'specialty_league', 'lunch', 'dismissal'].includes((tl[i + 1].type || '').toLowerCase()))),
                });
            }
        }
        return out;
    }

    function scanWallStructure() {
        const out = {};
        const timelines = window.bunkTimelines || {};
        for (const bunk of allBunks()) {
            const tl = (timelines[bunk] || []).slice().sort((a, b) => a.startMin - b.startMin);
            const walls = tl.filter(b => {
                const t = (b.type || '').toLowerCase();
                return b._fixed || b._classification === 'pinned' || ['league', 'specialty_league', 'lunch', 'dismissal'].includes(t);
            });
            const gaps = [];
            for (let i = 0; i < walls.length - 1; i++) {
                const g = walls[i + 1].startMin - walls[i].endMin;
                if (g > 0) {
                    gaps.push({
                        between: `${blockSummary(walls[i])} → ${blockSummary(walls[i + 1])}`,
                        gap: g,
                        gapMin: minToTime(walls[i].endMin) + '-' + minToTime(walls[i + 1].startMin),
                    });
                }
            }
            out[bunk] = {
                walls: walls.length,
                wallList: walls.map(blockSummary),
                interWallGaps: gaps,
                shortGaps: gaps.filter(g => g.gap < resolveSportDMin(bunkGrade(bunk))),
            };
        }
        return out;
    }

    function categorizeLogs() {
        const cats = {
            'DUR-FLEX': [],
            'PLACEMENT-STUCK': [],
            'REBAL-STUCK': [],
            'REBAL': [],
            'Phase2.5-warnings': [],
            'Phase3-warnings': [],
            'ENFORCE': [],
            'other': [],
        };
        for (const entry of _state.logs) {
            const t = entry.text;
            if (t.includes('DUR-FLEX')) cats['DUR-FLEX'].push(t);
            else if (t.includes('PLACEMENT-STUCK')) cats['PLACEMENT-STUCK'].push(t);
            else if (t.includes('REBAL-STUCK')) cats['REBAL-STUCK'].push(t);
            else if (t.includes('[REBAL]')) cats['REBAL'].push(t);
            else if (t.includes('[Phase2.5]') && entry.level === 'warn') cats['Phase2.5-warnings'].push(t);
            else if (t.includes('[Phase3]') && entry.level === 'warn') cats['Phase3-warnings'].push(t);
            else if (t.includes('ENFORCE')) cats['ENFORCE'].push(t);
            else cats['other'].push(t);
        }
        return cats;
    }

    // ---- public API --------------------------------------------------------
    const SchedulerAudit = {
        start() {
            _state.logs = [];
            _state.capturing = true;
            _state.startedAt = Date.now();
            _state.stoppedAt = null;
            installHook();
            c.ok('SchedulerAudit capture STARTED. Now click Generate in the UI.');
            c.info('When it finishes, call: SchedulerAudit.report()');
            return 'started';
        },

        stop() {
            _state.capturing = false;
            _state.stoppedAt = Date.now();
            c.ok('SchedulerAudit capture STOPPED. ' + _state.logs.length + ' log lines captured.');
            return 'stopped';
        },

        report() {
            // Auto-stop on first report
            if (_state.capturing) this.stop();

            c.h1('Scheduler Audit Report');

            // 1. Sub-dMin blocks
            c.h2('1. Sub-dMin sport/slot blocks in the final schedule');
            const subs = scanSubDMinBlocks();
            if (subs.length === 0) {
                c.ok('No sub-dMin sport/slot blocks found. ✨');
            } else {
                c.bad(subs.length + ' sub-dMin block(s) found:');
                console.table(subs.map(s => ({
                    bunk: s.bunk, grade: s.grade, event: s.event, dur: s.dur,
                    dMin: s.sportDMin, deficit: s.deficit, source: s.source,
                    prevPinned: s.prevPinned, nextPinned: s.nextPinned,
                })));
                const bySource = {};
                subs.forEach(s => { bySource[s.source] = (bySource[s.source] || 0) + 1; });
                c.info('By source:', bySource);
                const bothPinned = subs.filter(s => s.prevPinned && s.nextPinned).length;
                c.info(bothPinned + '/' + subs.length + ' have BOTH neighbors pinned (structural — walls need adjustment)');
            }

            // 2. Captured logs by category
            c.h2('2. Log messages captured during generation');
            const cats = categorizeLogs();
            Object.entries(cats).forEach(([cat, lines]) => {
                if (lines.length === 0) return;
                if (cat === 'other') return;
                c.info(cat + ': ' + lines.length + ' entries');
                if (lines.length <= 15) {
                    lines.forEach(l => console.log('  ' + l));
                } else {
                    lines.slice(0, 10).forEach(l => console.log('  ' + l));
                    console.log('  ... and ' + (lines.length - 10) + ' more (use SchedulerAudit.logs("' + cat + '") to see all)');
                }
            });

            // 3. Duration flex summary
            c.h2('3. Duration-flex activations');
            const flex = cats['DUR-FLEX'];
            if (flex.length === 0) {
                c.info('No DUR-FLEX activations. Either all specials placed cleanly at configured duration, or all alt durations also had dead gaps.');
            } else {
                c.ok(flex.length + ' specials were shortened to eliminate dead gaps:');
                flex.forEach(l => console.log('  ' + l));
            }

            // 4. Placement-stuck summary
            c.h2('4. Placement-stuck specials (structural issues)');
            const stuck = cats['PLACEMENT-STUCK'];
            if (stuck.length === 0) {
                c.ok('No placement-stuck specials. ✨');
            } else {
                c.bad(stuck.length + ' specials couldn\'t find a clean placement even after duration flex:');
                stuck.forEach(l => console.log('  ' + l));
                c.info('These specials are structurally incompatible with the wall configuration. Either reduce their configured duration or change the adjacent pinned walls (lunch, league, custom).');
            }

            // 5. Wall structure per bunk (sample)
            c.h2('5. Wall structure — bunks with short inter-wall gaps');
            const walls = scanWallStructure();
            const problematic = Object.entries(walls).filter(([_, w]) => w.shortGaps.length > 0);
            if (problematic.length === 0) {
                c.ok('No bunks have sub-dMin gaps between pinned walls. ✨');
            } else {
                c.warn(problematic.length + ' bunks have one or more sub-dMin gaps between pinned walls.');
                // Show the first few
                problematic.slice(0, 5).forEach(([bunk, w]) => {
                    console.log('  bunk ' + bunk + ':');
                    w.shortGaps.forEach(g => {
                        console.log('    ' + g.gap + 'min gap ' + g.gapMin + ' — ' + g.between);
                    });
                });
                if (problematic.length > 5) {
                    console.log('  ... and ' + (problematic.length - 5) + ' more bunks (SchedulerAudit.bunk("X") for details)');
                }
            }

            // 6. Layer config (sanity check)
            c.h2('6. Layer configuration (sanity check)');
            const cfg = layerConfig();
            Object.entries(cfg).forEach(([grade, info]) => {
                const sportLayer = info.layers.find(l => (l.type || '').toLowerCase().startsWith('sport'));
                if (sportLayer) {
                    console.log('  ' + grade + ': ' + info.start + '-' + info.end + ' | sport dMin=' + sportLayer.dMin + ', dMax=' + sportLayer.dMax);
                } else {
                    console.log('  ' + grade + ': ' + info.start + '-' + info.end + ' | no sport layer detected');
                }
            });

            // 7. Summary
            c.h2('7. Summary');
            const summary = {
                subDMinBlocks: subs.length,
                subDMinBothPinnedNeighbors: subs.filter(s => s.prevPinned && s.nextPinned).length,
                durFlexActivations: flex.length,
                placementStuckSpecials: stuck.length,
                rebalStuck: cats['REBAL-STUCK'].length,
                rebalSuccesses: cats['REBAL'].length,
                enforceFixups: cats['ENFORCE'].length,
                totalLogLines: _state.logs.length,
                bunksWithShortInterWallGaps: problematic.length,
            };
            console.table([summary]);

            // Stash everything for copy-paste
            const blob = {
                summary,
                subDMinBlocks: subs,
                logsByCategory: cats,
                walls,
                layerConfig: cfg,
                capturedAt: new Date().toISOString(),
            };
            window.SchedulerAudit._last = blob;
            c.info('Full JSON report attached to window.SchedulerAudit._last — you can do:');
            c.info('  copy(JSON.stringify(SchedulerAudit._last, null, 2))   ← copies to clipboard');
            c.info('  ...then paste to Claude for deep analysis');

            return blob;
        },

        bunk(bunkId) {
            const tl = (window.bunkTimelines || {})[String(bunkId)] || [];
            const grade = bunkGrade(bunkId);
            const sportDMin = resolveSportDMin(grade);
            c.h1('Bunk ' + bunkId + ' (' + grade + ') — sport dMin=' + sportDMin);
            const rows = tl.slice().sort((a, b) => a.startMin - b.startMin).map(b => ({
                time: minToTime(b.startMin) + '-' + minToTime(b.endMin),
                dur: b.endMin - b.startMin,
                type: b.type,
                event: b.event || b._assignedSport || b._assignedSpecial || '',
                field: b.field || b._specialLocation || '',
                source: b._source || '',
                pinned: b._fixed || b._classification === 'pinned' || ['league', 'specialty_league', 'lunch', 'dismissal'].includes((b.type || '').toLowerCase()),
            }));
            console.table(rows);
            return rows;
        },

        walls() {
            const walls = scanWallStructure();
            c.h1('Wall structure');
            Object.entries(walls).forEach(([bunk, w]) => {
                c.h2('Bunk ' + bunk + ' — ' + w.walls + ' walls');
                w.wallList.forEach(l => console.log('  ' + l));
                if (w.interWallGaps.length > 0) {
                    console.log('  Gaps:');
                    w.interWallGaps.forEach(g => console.log('    ' + g.gap + 'min ' + g.gapMin + ' (between ' + g.between + ')'));
                }
            });
            return walls;
        },

        issues() {
            const subs = scanSubDMinBlocks();
            const cats = categorizeLogs();
            c.h1('Issues only');
            if (subs.length > 0) {
                c.bad('Sub-dMin blocks:');
                console.table(subs.map(s => ({ bunk: s.bunk, event: s.event, dur: s.dur, dMin: s.sportDMin, source: s.source })));
            }
            if (cats['PLACEMENT-STUCK'].length > 0) {
                c.bad('Placement-stuck specials:');
                cats['PLACEMENT-STUCK'].forEach(l => console.log('  ' + l));
            }
            if (cats['REBAL-STUCK'].length > 0) {
                c.bad('Rebalance-stuck blocks:');
                cats['REBAL-STUCK'].forEach(l => console.log('  ' + l));
            }
            return { subDMinBlocks: subs, placementStuck: cats['PLACEMENT-STUCK'], rebalStuck: cats['REBAL-STUCK'] };
        },

        logs(substring) {
            const filtered = _state.logs.filter(l => !substring || l.text.includes(substring));
            c.h1('Logs' + (substring ? ' matching "' + substring + '"' : '') + ' — ' + filtered.length + ' entries');
            filtered.forEach(l => console.log('[' + l.level + '] ' + l.text));
            return filtered;
        },

        clear() {
            _state.logs = [];
            c.info('Cleared captured logs.');
        },

        _state,
        _last: null,
    };

    window.SchedulerAudit = SchedulerAudit;
    console.log('%cSchedulerAudit loaded.', 'color:#1b5e20;font-weight:bold');
    console.log('Usage:');
    console.log('  1. SchedulerAudit.start()    ← BEFORE clicking Generate');
    console.log('  2. Click Generate in UI');
    console.log('  3. SchedulerAudit.report()   ← gets everything I need');
    console.log('  copy(JSON.stringify(SchedulerAudit._last, null, 2))   ← copy JSON for paste');
})();
