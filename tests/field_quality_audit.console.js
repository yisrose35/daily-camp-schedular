/* =========================================================================
 * Field Quality Audit — standalone
 *
 * Verifies the existing schedule respected field quality groups: when a bunk
 * was placed on a lower-ranked field in a group, the audit checks whether a
 * better-ranked field in the same group was actually free at that time and
 * unblocked by any rule. Flags genuine misses; explains legitimate skips.
 *
 * Usage:
 *   FieldQualityAudit.check()        — run on the current schedule
 *   FieldQualityAudit.detail()       — print full per-group rank table
 *
 * Reads (no regeneration):
 *   window.scheduleAssignments
 *   window.divisionTimes
 *   window.divisions
 *   loadGlobalSettings().app1.fields  (timeRules, accessRestrictions, qualityRank, fieldGroup, activities)
 * ========================================================================= */

(function () {
    'use strict';

    const c = {
        ok:   (...a) => console.log('%c ✓ ', 'background:#1b5e20;color:#fff;border-radius:3px', ...a),
        warn: (...a) => console.log('%c ⚠ ', 'background:#ef6c00;color:#fff;border-radius:3px', ...a),
        info: (...a) => console.log('%c i ', 'background:#0d47a1;color:#fff;border-radius:3px', ...a),
        skip: (...a) => console.log('%c — ', 'background:#78909c;color:#fff;border-radius:3px', ...a),
        h1:   (s)    => console.log('\n%c ' + s + ' ', 'font-size:14px;font-weight:bold;background:#222;color:#fff;padding:4px 10px;border-radius:4px'),
    };

    const _norm = (s) => (s ? String(s).toLowerCase().trim() : '');

    function _fmt(min) {
        if (min == null) return '??';
        const h = Math.floor(min / 60), m = min % 60, ampm = h >= 12 ? 'pm' : 'am';
        const h12 = h % 12 === 0 ? 12 : h % 12;
        return h12 + ':' + (m < 10 ? '0' + m : m) + ampm;
    }

    // Build a per-bunk → division lookup from window.divisions.
    function _buildBunkDivision() {
        const map = new Map();
        const divs = window.divisions || {};
        for (const div in divs) {
            const bunks = (divs[div] && divs[div].bunks) || [];
            for (const b of bunks) map.set(String(b), div);
        }
        return map;
    }

    // Replicates solver seniority: sort by trailing grade number desc.
    // Highest grade number = seniority index 0 = ideal rank 1 (best field).
    function _buildSeniorityMap() {
        const divs = window.divisions || {};
        const names = Object.keys(divs);
        const withNum = names.map(n => {
            const m = String(n).match(/(\d+)/);
            return { name: n, num: m ? parseInt(m[1], 10) : 0 };
        });
        withNum.sort((a, b) => b.num - a.num);
        const map = {};
        withNum.forEach((d, i) => { map[d.name] = i; });
        return map;
    }

    // Returns a string reason if `fieldCfg` is a legitimate skip for this entry,
    // null if no blocking rule found (i.e. solver had no excuse).
    function _skipReason(fieldCfg, entry) {
        // 1. Time rules
        const timeRules = fieldCfg.timeRules || [];
        for (const r of timeRules) {
            const sm = r.startMin, em = r.endMin;
            if (sm == null || em == null) continue;
            const type = (r.type || '').toLowerCase();
            if (type === 'unavailable' && entry.startMin < em && entry.endMin > sm) {
                return `time rule: Unavailable ${_fmt(sm)}–${_fmt(em)}`;
            }
        }
        const availables = timeRules.filter(r => (r.type || '').toLowerCase() === 'available' && r.startMin != null && r.endMin != null);
        if (availables.length > 0 && !availables.some(r => entry.startMin >= r.startMin && entry.endMin <= r.endMin)) {
            return `time rule: not within any Available window`;
        }
        // 2. Access restrictions
        if (fieldCfg.accessRestrictions?.enabled && entry.divName) {
            const allowed = fieldCfg.accessRestrictions.divisions || {};
            if (!(entry.divName in allowed)) {
                return `access restriction: division "${entry.divName}" not permitted`;
            }
        }
        // 3. Global field locks — leagues / pinned events / electives lock fields
        //    without putting blocks in scheduleAssignments, so the occupancy
        //    check above can't see them. Ask the lock registry directly.
        const GFL = window.GlobalFieldLocks;
        if (GFL) {
            try {
                const lock = GFL.isFieldLockedByTime
                    ? GFL.isFieldLockedByTime(fieldCfg.name, entry.startMin, entry.endMin, entry.divName)
                    : (GFL.isFieldLocked?.(fieldCfg.name, [], entry.divName) || null);
                if (lock) {
                    const who = lock.lockedBy || 'lock';
                    const what = lock.leagueName || lock.activity || lock.reason || '';
                    return `locked by ${who}${what ? ': ' + what : ''}`;
                }
            } catch (_) {}
        }
        return null;
    }

    function _buildTimeline() {
        const sa = window.scheduleAssignments || {};
        const dt = window.divisionTimes || {};
        const bunkDiv = _buildBunkDivision();
        const out = [];
        Object.entries(sa).forEach(([bunk, slots]) => {
            if (!Array.isArray(slots)) return;
            const div = bunkDiv.get(String(bunk)) || null;
            const divSlots = div ? (dt[div] || []) : [];
            slots.forEach((s, i) => {
                if (!s || s.continuation || s._isTransition) return;
                let sm = s._startMin, em = s._endMin;
                if (sm == null && divSlots[i]) { sm = divSlots[i].startMin; em = divSlots[i].endMin; }
                if (sm == null) return;
                out.push({
                    bunk, divName: div, field: s.field || null,
                    activity: (s._activity || s.field || '').toLowerCase().trim(),
                    startMin: sm, endMin: em
                });
            });
        });
        return out;
    }

    function _loadFieldMeta() {
        const settings = window.loadGlobalSettings?.() || {};
        const fields = settings.app1?.fields || settings.fields || [];
        const meta = {};         // name -> { group, rank, activities:Set, timeRules, accessRestrictions }
        const groups = {};       // group -> [{name, rank, activities, timeRules, accessRestrictions}, ...]
        fields.forEach(f => {
            if (!f.fieldGroup) return;
            const entry = {
                name: f.name,
                group: f.fieldGroup,
                rank: f.qualityRank ?? 999,
                activities: new Set((f.activities || []).map(_norm)),
                timeRules: f.timeRules || [],
                accessRestrictions: f.accessRestrictions || {}
            };
            meta[f.name] = entry;
            if (!groups[f.fieldGroup]) groups[f.fieldGroup] = [];
            groups[f.fieldGroup].push(entry);
        });
        Object.values(groups).forEach(arr => arr.sort((a, b) => a.rank - b.rank));
        return { meta, groups };
    }

    function check() {
        console.clear();
        c.h1('Field Quality Audit');
        console.log('Date:', new Date().toLocaleString());

        const sa = window.scheduleAssignments || {};
        if (!Object.keys(sa).length) {
            c.warn('window.scheduleAssignments is empty — generate a schedule first');
            return;
        }

        const { meta, groups } = _loadFieldMeta();
        if (!Object.keys(groups).length) {
            c.skip('No field quality groups configured');
            return;
        }

        // Print group summary
        Object.entries(groups).forEach(([gName, arr]) => {
            c.info(`Group "${gName}": ` + arr.map(f => `#${f.rank} ${f.name}`).join(' › '));
        });
        console.log('');

        const timeline = _buildTimeline();

        // Per-group occupancy intervals (from any block on a group field)
        const occupancy = {}; // group -> [{field, startMin, endMin}]
        timeline.forEach(e => {
            if (!e.field) return;
            const m = meta[e.field];
            if (!m) return;
            if (!occupancy[m.group]) occupancy[m.group] = [];
            occupancy[m.group].push({ field: e.field, startMin: e.startMin, endMin: e.endMin });
        });

        let checked = 0, warnings = 0, explained = 0;

        timeline.forEach(used => {
            if (!used.field) return;
            const m = meta[used.field];
            if (!m) return;
            checked++;
            const groupArr = groups[m.group];
            const occ = occupancy[m.group] || [];

            // Better fields = lower rank than `used`
            const better = groupArr.filter(f => f.rank < m.rank);
            if (!better.length) return;

            // Of those, find ones supporting this activity AND not occupied during this interval
            const candidates = better.filter(f => {
                if (f.activities.size > 0 && used.activity && !f.activities.has(used.activity)) return false;
                const isOccupied = occ.some(o => o.field === f.name && o.endMin > used.startMin && o.startMin < used.endMin);
                return !isOccupied;
            });
            if (!candidates.length) return;

            // For each free-better-supports candidate, look up if a rule blocked it
            const top = candidates[0];
            const reason = _skipReason(top, used);
            if (reason) {
                explained++;
                c.info(`Bunk ${used.bunk} (${used.divName}) at ${_fmt(used.startMin)}: used "${used.field}" (rank ${m.rank}) — "${top.name}" (rank ${top.rank}) blocked: ${reason}`);
            } else {
                warnings++;
                c.warn(`Bunk ${used.bunk} (${used.divName}) at ${_fmt(used.startMin)}: used "${used.field}" (rank ${m.rank}) — "${top.name}" (rank ${top.rank}) was FREE with no blocking rule (possible solver miss)`);
            }
        });

        console.log('');
        if (warnings === 0 && explained === 0) {
            c.ok(`${checked} field assignment(s) — quality order respected`);
        } else {
            if (warnings > 0) c.warn(`${warnings} unexplained skip(s) — solver chose lower-ranked field when a better one was free`);
            if (explained > 0) c.info(`${explained} skip(s) explained by time rules / access restrictions`);
        }
    }

    function detail() {
        const { groups } = _loadFieldMeta();
        if (!Object.keys(groups).length) { c.skip('No field quality groups configured'); return; }
        c.h1('Field Quality Groups — full table');
        Object.entries(groups).forEach(([gName, arr]) => {
            console.log('%c' + gName, 'font-weight:bold;color:#0d47a1');
            arr.forEach(f => console.log('  #' + f.rank + '  ' + f.name + (f.activities.size ? '  [' + [...f.activities].join(', ') + ']' : '')));
        });
    }

    window.FieldQualityAudit = { check, detail };
    console.log('%c FieldQualityAudit loaded ', 'background:#1b5e20;color:#fff;padding:2px 6px;border-radius:4px',
        '— run FieldQualityAudit.check() or FieldQualityAudit.detail()');
})();
