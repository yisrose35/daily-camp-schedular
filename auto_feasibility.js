// =============================================================================
// auto_feasibility.js — PRE-FLIGHT FEASIBILITY REPORT (Phase A1)
// =============================================================================
//
// Runs ONCE at the start of runAutoScheduler, before any iteration. Inspects
// the config (divisions, layers, fields, specials, daily overrides) and tells
// the caller — and the user — whether the day is structurally fillable.
//
// THREE FAILURE CATEGORIES this module surfaces:
//
//   Cause 1 — Bunk-level pool exhaustion
//     A bunk's `uniqueSportPool` (sports it can actually do today after
//     access/timeRules/disabledFields/rainy/disabledSports filters) is
//     smaller than its `sportSlotsNeeded`. No algorithm can fill the
//     remaining slots without violating the same-day-no-repeat rule.
//
//   Cause 2 — Window-level capacity deficit (Hall's margin)
//     At time window W, demand (bunks needing a sport-slot) exceeds supply
//     (capacity-weighted field-slots available for those bunks' grades).
//     The matching is mathematically infeasible at that window regardless
//     of which sport each bunk picks.
//
//   Cause 3 — Special contention
//     A scarce special has fewer simultaneous-slots than grades demanding
//     it within its time window. Without staggering or relaxing access,
//     some grade won't get the special.
//
// THIS MODULE IS PURE OBSERVATION. It does NOT write to scheduleAssignments,
// does NOT modify layers, does NOT block generation. It logs and stamps a
// report at `window._lastFeasibilityReport` for downstream consumers (Phase
// B matcher, Phase C layout-swap, user-facing diagnostics).
//
// Browser globals it consumes (read-only):
//   - window.scheduleAssignments  — not yet populated at pre-flight time; ignored
//   - window.activityProperties   — for sport→fields, sharing types, time rules
//   - window.currentDisabledFields (passed in) — merged daily disabled list
//   - window.SchedulerCoreUtils.parseTimeToMinutes — for time parsing
//   - window.RotationEngine        — not consulted in Phase A (algorithmic, not config)
//
// Test convention: this module is loadable into a vm sandbox via
//   loadInto('auto_feasibility.js', ctx)
// See tests/auto_feasibility.test.js for the test pattern.
//
// =============================================================================

(function () {
    'use strict';

    const VERSION = '1.0.0';
    const TAG = '[AutoFeasibility]';

    function log(msg, ...args) { try { console.log(TAG + ' ' + msg, ...args); } catch (_) {} }
    function warn(msg, ...args) { try { console.warn(TAG + ' ⚠️ ' + msg, ...args); } catch (_) {} }

    // -------------------------------------------------------------------------
    // Helpers — defensive, work in both browser + vm-sandbox contexts.
    // -------------------------------------------------------------------------

    function parseTime(v) {
        if (v == null) return null;
        if (typeof v === 'number') return v;
        // Prefer the audited helper when present.
        const u = (typeof window !== 'undefined') ? window.SchedulerCoreUtils : null;
        if (u && typeof u.parseTimeToMinutes === 'function') {
            try { return u.parseTimeToMinutes(v); } catch (_) {}
        }
        // Fallback parser — matches the audit's contract.
        let s = String(v).toLowerCase().trim();
        const isPM = s.includes('pm'), isAM = s.includes('am');
        s = s.replace(/am|pm/g, '').trim();
        const parts = s.split(':');
        let h = parseInt(parts[0], 10);
        if (isNaN(h)) return null;
        const m = parseInt(parts[1], 10) || 0;
        if (isPM && h !== 12) h += 12;
        if (isAM && h === 12) h = 0;
        return h * 60 + m;
    }

    function getDivisionRecord(divisions, grade) {
        // Dual-key (audit fix N16): grade may be string or number-coerced.
        return (divisions || {})[grade] || (divisions || {})[String(grade)] || null;
    }

    function getDayBounds(div) {
        return {
            start: parseTime(div?.startTime) ?? 540,
            end:   parseTime(div?.endTime)   ?? 960
        };
    }

    // Parse a layer's qty/op spec into {floor, cap}. Same parser as the
    // shopping-list builder; reproduced here so Phase A doesn't depend on
    // the iteration loop having run yet.
    function parseQtyOp(layer) {
        const qRaw = String(layer.qty != null ? layer.qty : (layer.quantity != null ? layer.quantity : ''));
        const oRaw = String(layer.op  != null ? layer.op  : (layer.operator != null ? layer.operator : ''));
        const combined = (qRaw + oRaw).trim();
        const m = combined.match(/^(\d*)\s*(>=|<=|≥|≤|>|<|=)\s*(\d*)$/);
        let qty, op;
        if (m) {
            const nb = m[1], opTok = m[2], na = m[3];
            qty = parseInt(nb || na || '1', 10) || 1;
            op  = (opTok === '≥' || opTok === '>') ? '>='
                : (opTok === '≤' || opTok === '<') ? '<='
                : opTok;
        } else {
            qty = parseInt(qRaw, 10) || 1;
            op  = '>=';
        }
        if (op === '<=') return { floor: 0, cap: qty };
        if (op === '=')  return { floor: qty, cap: qty };
        return { floor: qty, cap: Infinity };
    }

    // Returns true if field is currently allowed for this grade based on
    // access restrictions. Dual-key (audit N6).
    function isFieldAccessibleForGrade(field, grade) {
        const ar = field && field.accessRestrictions;
        if (!ar || !ar.enabled) return true;
        const divs = ar.divisions || {};
        const gKey = String(grade);
        if (!(gKey in divs) && !(grade in divs)) return false;
        // We do not narrow further by bunk here; Phase A asks
        // "can this grade EVER use this field today?" — per-bunk
        // narrowing is downstream.
        return true;
    }

    // Returns true if [winStart, winEnd] overlaps ANY Available time rule
    // for this grade on this field. Mirrors fieldLedger.timeRules semantics.
    // A field with no Available rules is treated as always-available
    // (the ledger backfills a default rule covering camp hours).
    function fieldHasAvailableSliceForGrade(field, grade) {
        const rules = (field && field.timeRules) || [];
        if (rules.length === 0) return true;
        const myG = String(grade);
        for (let i = 0; i < rules.length; i++) {
            const r = rules[i];
            const t = String(r.type || '').toLowerCase();
            const isAvail = t === 'available' || r.available === true;
            if (!isAvail) continue;
            const rDivs = Array.isArray(r.divisions) ? r.divisions.map(String) : [];
            if (rDivs.length > 0 && !rDivs.includes(myG)) continue;
            return true;
        }
        return false;
    }

    // Returns true if field is fully blocked by Unavailable rules across
    // the entire camp day for this grade.
    function fieldFullyBlockedByUnavailable(field, grade, dayStart, dayEnd) {
        const rules = (field && field.timeRules) || [];
        if (rules.length === 0) return false;
        const myG = String(grade);
        // Cover the day with merged Unavailable segments; if union covers
        // [dayStart, dayEnd] fully, the field is unusable today for this grade.
        const unavail = [];
        for (let i = 0; i < rules.length; i++) {
            const r = rules[i];
            const t = String(r.type || '').toLowerCase();
            const isUnavail = t === 'unavailable' || r.available === false;
            if (!isUnavail) continue;
            const rDivs = Array.isArray(r.divisions) ? r.divisions.map(String) : [];
            if (rDivs.length > 0 && !rDivs.includes(myG)) continue;
            const s = r.startMin != null ? r.startMin : parseTime(r.start || r.startTime);
            const e = r.endMin   != null ? r.endMin   : parseTime(r.end   || r.endTime);
            if (s == null || e == null) continue;
            unavail.push([Math.max(s, dayStart), Math.min(e, dayEnd)]);
        }
        if (unavail.length === 0) return false;
        unavail.sort((a, b) => a[0] - b[0]);
        let cur = dayStart;
        for (const [s, e] of unavail) {
            if (s > cur) return false;       // gap before this segment
            if (e > cur) cur = e;
        }
        return cur >= dayEnd;
    }

    // -------------------------------------------------------------------------
    // Pool analysis — what sports can a given (grade, bunk) actually do today?
    // -------------------------------------------------------------------------

    function buildSportFieldMap(globalSettings, disabledFields) {
        // sport name → array of field objects that host it (after filtering
        // disabled fields).
        const fields = (globalSettings.app1?.fields || globalSettings.fields || []);
        const disabledSet = new Set(disabledFields || []);
        const map = new Map();
        for (const f of fields) {
            if (!f || !f.name) continue;
            if (disabledSet.has(f.name)) continue;
            const acts = f.activities || [];
            for (const act of acts) {
                if (!map.has(act)) map.set(act, []);
                map.get(act).push(f);
            }
        }
        return map;
    }

    function computeUniqueSportPool(grade, bunk, opts) {
        const {
            sportFieldMap, disabledSportsByField, isRainy,
            dayStart, dayEnd
        } = opts;
        const pool = [];
        for (const [sport, fields] of sportFieldMap) {
            let anyFieldOk = false;
            for (const field of fields) {
                // Rainy → only indoor fields count.
                if (isRainy && !field.isIndoor) continue;

                // Per-field daily sport disabled list.
                const disabledOnField = (disabledSportsByField && disabledSportsByField[field.name]) || [];
                if (disabledOnField.includes(sport)) continue;

                // Grade access.
                if (!isFieldAccessibleForGrade(field, grade)) continue;

                // Field must have at least one Available slice for this grade.
                if (!fieldHasAvailableSliceForGrade(field, grade)) continue;

                // Field must not be fully covered by Unavailable for this grade.
                if (fieldFullyBlockedByUnavailable(field, grade, dayStart, dayEnd)) continue;

                anyFieldOk = true;
                break;
            }
            if (anyFieldOk) pool.push(sport);
        }
        return pool;
    }

    // -------------------------------------------------------------------------
    // Per-bunk feasibility — compute sportSlotsNeeded vs uniqueSportPool.
    // -------------------------------------------------------------------------

    function analyzeBunk(bunk, grade, opts) {
        const {
            divisions, layers,
            sportFieldMap, disabledSportsByField, isRainy,
            activityProperties
        } = opts;
        const div = getDivisionRecord(divisions, grade);
        const { start: dayStart, end: dayEnd } = getDayBounds(div);
        const totalMin = Math.max(0, dayEnd - dayStart);

        // Time consumed by non-sport layers (anchors + leagues + specials + custom).
        // We use floor durations (periodMin or layer.duration) to estimate the
        // minimum committed time; sports get whatever's left.
        let anchorMin = 0;
        let sportLayerFloor = null;     // qty floor for sport layer
        let sportLayerCap   = null;     // qty cap for sport layer
        let sportDMin       = null;     // sport layer's per-block duration floor

        for (const layer of (layers || [])) {
            if ((layer.grade || layer.division) !== grade) continue;
            const t = (layer.type || '').toLowerCase();
            const dur = layer.periodMin || layer.duration || layer.durationMin || 0;

            if (t === 'sport' || t === 'sports') {
                const qo = parseQtyOp(layer);
                sportLayerFloor = qo.floor;
                sportLayerCap   = qo.cap;
                sportDMin = layer.durationMin || layer.periodMin || layer.duration || 25;
                continue;
            }

            // Non-sport: count its committed time. For windowed layers we
            // take the periodMin (one occurrence). For quantity>1 we
            // multiply by floor (the count it MUST place).
            const qo = parseQtyOp(layer);
            const reps = (qo.floor === Infinity || qo.floor === 0) ? 1 : qo.floor;
            anchorMin += dur * reps;
        }

        const freeMinAfterAnchors = Math.max(0, totalMin - anchorMin);
        const sportDurEst = sportDMin || 30;
        const maxSportSlotsByTime = Math.floor(freeMinAfterAnchors / sportDurEst);
        // The actual sport demand is whichever is *binding*: the layer's qty
        // floor (user said "need at least N sports") OR the time-derived max
        // (when no qty cap, the bunk will be filled until time runs out).
        let sportSlotsNeeded;
        if (sportLayerFloor == null) {
            sportSlotsNeeded = 0;             // no sport layer for this grade
        } else if (sportLayerCap === Infinity) {
            sportSlotsNeeded = Math.max(sportLayerFloor, maxSportSlotsByTime);
        } else {
            sportSlotsNeeded = Math.min(Math.max(sportLayerFloor, 0), sportLayerCap || sportLayerFloor);
        }

        const uniqueSportPool = computeUniqueSportPool(grade, bunk, {
            sportFieldMap, disabledSportsByField, isRainy,
            dayStart, dayEnd
        });

        const poolDeficit = Math.max(0, sportSlotsNeeded - uniqueSportPool.length);

        return {
            bunk: String(bunk),
            grade,
            dayStart, dayEnd, totalMin,
            anchorMin, freeMinAfterAnchors,
            sportDMin: sportDMin || null,
            sportLayerFloor, sportLayerCap,
            sportSlotsNeeded,
            uniqueSportPool: uniqueSportPool.slice(),   // copy
            poolSize: uniqueSportPool.length,
            poolDeficit,
            flagged: poolDeficit > 0
        };
    }

    // -------------------------------------------------------------------------
    // Per-window field-supply check (Hall's margin lite).
    // We sample 30-min slices across the camp day and compute, per slice:
    //   demand[grade] = number of bunks in grade whose sport-fill window covers t
    //   supply[grade] = number of (field × capacity) slots accessible to grade at t
    //                   (after rainy + access + timeRules)
    // Deficit = max(0, demand - supply).
    // -------------------------------------------------------------------------

    function analyzeWindows(opts) {
        const {
            divisions, perBunk, globalSettings,
            disabledFields, isRainy, dayStart, dayEnd
        } = opts;
        const fields = (globalSettings.app1?.fields || globalSettings.fields || []);
        const disabledSet = new Set(disabledFields || []);

        const SLICE = 30;
        const out = [];

        for (let t = dayStart; t < dayEnd; t += SLICE) {
            const sEnd = t + SLICE;
            const demand = {}, supply = {};

            // Demand: bunks whose freeMinAfterAnchors covers [t, t+SLICE]
            // and which still need sport slots. We treat the bunk's whole
            // day as "available for sports" minus the time already booked
            // by anchors — an upper bound, since we don't yet know where
            // each anchor lands.
            for (const b of Object.values(perBunk)) {
                if (b.sportSlotsNeeded === 0) continue;
                if (t >= b.dayEnd || sEnd <= b.dayStart) continue;
                demand[b.grade] = (demand[b.grade] || 0) + 1;
            }

            // Supply: per-grade count of field-slots usable at this slice.
            // A field with capacity C contributes up to C slots if accessible
            // to the grade at this slice (rainy + access + timeRules).
            const allGrades = Array.from(new Set(Object.values(perBunk).map(b => b.grade)));
            for (const grade of allGrades) {
                let s = 0;
                for (const f of fields) {
                    if (!f || !f.name) continue;
                    if (disabledSet.has(f.name)) continue;
                    if (isRainy && !f.isIndoor) continue;
                    if (!isFieldAccessibleForGrade(f, grade)) continue;
                    if (!fieldHasAvailableSliceForGrade(f, grade)) continue;
                    // Specifically: does the field cover [t, sEnd] for this grade?
                    if (!sliceCoveredByAvailable(f, grade, t, sEnd)) continue;
                    const cap = parseInt((f.sharableWith || {}).capacity) || (f.sharableWith?.type === 'not_sharable' ? 1 : 2);
                    s += cap;
                }
                supply[grade] = s;
            }

            const hallDeficit = {};
            let anyDeficit = false;
            for (const grade of allGrades) {
                const d = demand[grade] || 0;
                const sp = supply[grade] || 0;
                if (d > sp) { hallDeficit[grade] = d - sp; anyDeficit = true; }
            }
            if (anyDeficit) {
                out.push({ startMin: t, endMin: sEnd, demand, supply, hallDeficit });
            }
        }
        return out;
    }

    function sliceCoveredByAvailable(field, grade, sliceStart, sliceEnd) {
        const rules = (field && field.timeRules) || [];
        if (rules.length === 0) return true;     // no rules ⇒ all-day available
        const myG = String(grade);
        let hasAvail = false;
        for (const r of rules) {
            const t = String(r.type || '').toLowerCase();
            const isAvail = t === 'available' || r.available === true;
            const isUnavail = t === 'unavailable' || r.available === false;
            const rDivs = Array.isArray(r.divisions) ? r.divisions.map(String) : [];
            if (rDivs.length > 0 && !rDivs.includes(myG)) continue;
            const rs = r.startMin != null ? r.startMin : parseTime(r.start || r.startTime);
            const re = r.endMin   != null ? r.endMin   : parseTime(r.end   || r.endTime);
            if (rs == null || re == null) continue;
            if (isUnavail && rs < sliceEnd && re > sliceStart) return false;
            if (isAvail) {
                hasAvail = true;
                if (sliceStart >= rs && sliceEnd <= re) return true;
            }
        }
        return !hasAvail;   // no avail rules touching this grade ⇒ allow
    }

    // -------------------------------------------------------------------------
    // Per-special contention — how many grades demand it vs its capacity.
    // -------------------------------------------------------------------------

    function analyzeSpecials(opts) {
        const { divisions, layers, globalSettings } = opts;
        const specials = (globalSettings.app1?.specialActivities || globalSettings.specialActivities || []);
        const specialByName = {};
        specials.forEach(s => { if (s && s.name) specialByName[s.name] = s; });

        // Build demand: grade → set of special names demanded by its layers.
        const demand = {};   // specialName → { gradeDemand, totalBunks, totalGrades }
        for (const layer of (layers || [])) {
            const t = (layer.type || '').toLowerCase();
            if (t !== 'special') continue;
            const grade = layer.grade || layer.division;
            if (!grade) continue;
            const eventName = layer.event || layer.name || '';
            // If the layer ties to a specific special by name, use it. Otherwise
            // it's a generic 'special' layer — every special the grade can do.
            const names = eventName && specialByName[eventName] ? [eventName] : Object.keys(specialByName);
            const bunkCount = (getDivisionRecord(divisions, grade)?.bunks || []).length;
            for (const n of names) {
                if (!demand[n]) demand[n] = { gradeDemand: {}, totalBunks: 0, totalGrades: 0 };
                if (!demand[n].gradeDemand[grade]) {
                    demand[n].gradeDemand[grade] = 0;
                    demand[n].totalGrades++;
                }
                demand[n].gradeDemand[grade] += bunkCount;
                demand[n].totalBunks         += bunkCount;
            }
        }

        const out = {};
        for (const [name, d] of Object.entries(demand)) {
            const cfg = specialByName[name] || {};
            const cap = parseInt(cfg.sharableWith?.capacity) || (cfg.sharableWith?.type === 'not_sharable' ? 1 : 2);
            const isScarce = !!(cfg.availableDays?.length || cfg.mustScheduleWhenAvailable);
            out[name] = {
                name, capacity: cap, isScarce,
                gradeDemand: d.gradeDemand,
                totalBunksDemanding: d.totalBunks,
                totalGradesDemanding: d.totalGrades,
                contentionRatio: cap > 0 ? d.totalBunks / cap : Infinity
            };
        }
        return out;
    }

    // -------------------------------------------------------------------------
    // Recommendations — turn flagged items into actionable suggestions.
    // -------------------------------------------------------------------------

    function buildRecommendations(perBunk, perWindow, perSpecial) {
        const recs = [];

        // Cause 1 — per-bunk pool deficit.
        const flaggedBunks = Object.values(perBunk).filter(b => b.flagged);
        for (const b of flaggedBunks) {
            recs.push({
                severity: 'high',
                cause: 1,
                target: 'bunk:' + b.bunk,
                message: 'Bunk ' + b.bunk + ' (' + b.grade + ') needs ' + b.sportSlotsNeeded +
                    ' unique sport slots but only ' + b.poolSize + ' sports are available today.',
                action:
                    'Enable additional sports/fields for ' + b.grade + ', loosen this bunk\'s ' +
                    'access restrictions on already-disabled fields, or reduce the sport layer\'s ' +
                    'min quantity (currently floor=' + b.sportLayerFloor + ').',
                detail: { deficit: b.poolDeficit, pool: b.uniqueSportPool }
            });
        }

        // Cause 2 — window-level deficit.
        if (perWindow.length > 0) {
            const byGrade = {};
            for (const w of perWindow) {
                for (const [g, def] of Object.entries(w.hallDeficit)) {
                    if (!byGrade[g]) byGrade[g] = [];
                    byGrade[g].push({ startMin: w.startMin, endMin: w.endMin, deficit: def });
                }
            }
            for (const [grade, windows] of Object.entries(byGrade)) {
                recs.push({
                    severity: 'high',
                    cause: 2,
                    target: 'grade:' + grade,
                    message: grade + ' has field-capacity deficits at ' + windows.length +
                        ' time slice(s); peak shortfall is ' + Math.max(...windows.map(w => w.deficit)) + ' bunk(s).',
                    action:
                        'Enable an additional field accessible to ' + grade + ', or relax the ' +
                        'sharing rules on an existing field (e.g. raise capacity, switch from ' +
                        'not_sharable to same_division).',
                    detail: { windows }
                });
            }
        }

        // Cause 3 — special contention.
        for (const [name, sp] of Object.entries(perSpecial)) {
            if (sp.contentionRatio > 2 || (sp.isScarce && sp.contentionRatio > 1)) {
                recs.push({
                    severity: sp.isScarce ? 'high' : 'med',
                    cause: 3,
                    target: 'special:' + name,
                    message: 'Special "' + name + '" has contention ratio ' +
                        sp.contentionRatio.toFixed(2) + ' (capacity ' + sp.capacity +
                        ', ' + sp.totalBunksDemanding + ' bunks demanding across ' +
                        sp.totalGradesDemanding + ' grades).',
                    action: sp.isScarce
                        ? 'This special is scarce (limited availability). Consider raising capacity or marking another day as available.'
                        : 'Consider raising capacity or restricting which grades demand it via layer config.',
                    detail: sp.gradeDemand
                });
            }
        }

        return recs;
    }

    // -------------------------------------------------------------------------
    // Console summary — one block per generation, scannable.
    // -------------------------------------------------------------------------

    function printSummary(report) {
        log('═══════════════════════════════════════════════════════════');
        log('PRE-FLIGHT FEASIBILITY REPORT v' + VERSION);
        log('═══════════════════════════════════════════════════════════');

        const { perBunk, perWindow, perSpecial, recommendations, summary } = report;
        const bunkCount = Object.keys(perBunk).length;
        const flagged   = Object.values(perBunk).filter(b => b.flagged).length;

        log('Bunks analyzed:  ' + bunkCount + ' (' + flagged + ' at risk)');
        log('Window deficits: ' + perWindow.length);
        log('Specials:        ' + Object.keys(perSpecial).length + ' (' +
            Object.values(perSpecial).filter(s => s.contentionRatio > 1).length + ' contended)');
        log('Predicted min frees (Cause 1): ' + summary.predictedMinFrees);

        if (!report.feasible) {
            warn('Schedule is NOT fully fillable as currently configured.');
            warn('See recommendations below.');
        } else {
            log('Schedule appears structurally feasible. Algorithm quality will determine outcome.');
        }

        if (recommendations.length > 0) {
            log('--- Recommendations ---');
            recommendations.forEach((r, i) => {
                const sev = r.severity === 'high' ? '🔴' : r.severity === 'med' ? '🟡' : '🟢';
                log('  ' + (i + 1) + '. ' + sev + ' [Cause ' + r.cause + '] ' + r.message);
                log('     → ' + r.action);
            });
        }
        log('═══════════════════════════════════════════════════════════');
    }

    // -------------------------------------------------------------------------
    // Public entry point.
    // -------------------------------------------------------------------------

    function check(input) {
        input = input || {};
        const divisions = input.divisions || (typeof window !== 'undefined' ? window.divisions : null) || {};
        const layers    = input.layers || [];
        const globalSettings = input.globalSettings || (typeof window !== 'undefined' && typeof window.loadGlobalSettings === 'function' ? window.loadGlobalSettings() : {});
        const activityProperties = input.activityProperties || (typeof window !== 'undefined' ? window.activityProperties : null) || {};
        const isRainy = !!input.isRainy;
        const disabledFields = input.disabledFields
            || (typeof window !== 'undefined' ? window.currentDisabledFields : null)
            || (globalSettings.app1 && globalSettings.app1.disabledFields)
            || [];
        const disabledSportsByField = input.disabledSportsByField || {};

        // Per-bunk analysis.
        const sportFieldMap = buildSportFieldMap(globalSettings, disabledFields);
        const perBunk = {};
        for (const [grade, div] of Object.entries(divisions)) {
            const bunks = div?.bunks || [];
            for (const bunk of bunks) {
                perBunk[String(bunk)] = analyzeBunk(bunk, grade, {
                    divisions, layers, sportFieldMap,
                    disabledSportsByField, isRainy, activityProperties
                });
            }
        }

        // Aggregate dayStart/dayEnd across all grades for window analysis.
        let dayStart = Infinity, dayEnd = -Infinity;
        Object.values(perBunk).forEach(b => {
            if (b.dayStart < dayStart) dayStart = b.dayStart;
            if (b.dayEnd > dayEnd) dayEnd = b.dayEnd;
        });
        if (!isFinite(dayStart)) dayStart = 540;
        if (!isFinite(dayEnd))   dayEnd   = 960;

        const perWindow = analyzeWindows({
            divisions, perBunk, globalSettings,
            disabledFields, isRainy, dayStart, dayEnd
        });

        const perSpecial = analyzeSpecials({
            divisions, layers, globalSettings
        });

        const recommendations = buildRecommendations(perBunk, perWindow, perSpecial);

        // Predicted minimum Frees = sum of bunk-level pool deficits. This is
        // a lower bound; window-level deficits can add further but they
        // overlap with pool deficits in subtle ways, so we report them
        // separately as a quality signal rather than summing.
        let predictedMinFrees = 0;
        Object.values(perBunk).forEach(b => { predictedMinFrees += b.poolDeficit; });

        const feasible = recommendations.filter(r => r.severity === 'high').length === 0;

        const report = {
            version: VERSION,
            feasible,
            perBunk,
            perWindow,
            perSpecial,
            recommendations,
            summary: {
                totalBunksAtRisk: Object.values(perBunk).filter(b => b.flagged).length,
                totalWindowsAtRisk: perWindow.length,
                predictedMinFrees,
                generatedAt: Date.now()
            }
        };

        try { window._lastFeasibilityReport = report; } catch (_) {}
        try { printSummary(report); } catch (_) {}
        return report;
    }

    // -------------------------------------------------------------------------
    // Post-solve forensics — runs AFTER generation finishes. Scans
    // scheduleAssignments for Free blocks and produces a categorized
    // breakdown by `_freeReason`. Cross-references against the pre-flight
    // report (if present) to distinguish:
    //   - Frees that were predicted by the feasibility check (Cause 1/2)
    //     → user must change config
    //   - Frees that were NOT predicted (Cause 3 or algorithm miss)
    //     → opportunity for the matcher / layout-swap phases
    // -------------------------------------------------------------------------

    function REASON_LABEL(reason) {
        switch (reason) {
            case 'no_candidates':           return 'No candidates loaded for this slot';
            case 'invalid_block':           return 'Block had invalid time/bunk data';
            case 'pool_exhausted':          return 'Unique sport pool exhausted (Cause 1)';
            case 'capacity_deficit':        return 'No field had capacity at this time (Cause 2)';
            case 'all_disqualified':        return 'Mixed pool/capacity pressure';
            case 'constraint_demoted':      return 'Demoted by Step 4.5 constraint sweep';
            case 'rule_violation_cleared':  return 'Cleared by Step 4.95 rule safety net';
            case 'back_to_back_cleared':    return 'Cleared because of back-to-back same sport';
            case 'no_augmenting_path':      return 'Repair phase could not find a swap';
            case 'unknown':
            default:                        return 'Unknown / unstamped';
        }
    }

    function forensics(opts) {
        opts = opts || {};
        const sa = opts.scheduleAssignments
            || (typeof window !== 'undefined' ? window.scheduleAssignments : null)
            || {};
        const pre = opts.preflight
            || (typeof window !== 'undefined' ? window._lastFeasibilityReport : null)
            || null;

        const frees = [];   // { bunk, slotIdx, reason, blockers, startMin, endMin }
        for (const [bunk, slots] of Object.entries(sa)) {
            if (!Array.isArray(slots)) continue;
            slots.forEach((entry, idx) => {
                if (!entry) return;
                if (entry.field !== 'Free') return;
                if (entry.continuation) return;
                frees.push({
                    bunk: String(bunk),
                    slotIdx: idx,
                    reason: entry._freeReason || 'unknown',
                    blockers: entry._blockers || null,
                    startMin: entry._startMin ?? null,
                    endMin: entry._endMin ?? null
                });
            });
        }

        // Aggregate by reason.
        const byReason = {};
        frees.forEach(f => { byReason[f.reason] = (byReason[f.reason] || 0) + 1; });

        // Aggregate by bunk.
        const byBunk = {};
        frees.forEach(f => {
            if (!byBunk[f.bunk]) byBunk[f.bunk] = [];
            byBunk[f.bunk].push({ slotIdx: f.slotIdx, reason: f.reason });
        });

        // Cross-reference against pre-flight predictions.
        // `predicted` = Frees in bunks the pre-flight flagged as at-risk;
        // `unexpected` = Frees the pre-flight did NOT predict (these are
        // the ones that algorithm improvements can target).
        let predicted = 0, unexpected = 0;
        if (pre && pre.perBunk) {
            frees.forEach(f => {
                const pb = pre.perBunk[f.bunk];
                if (pb && pb.flagged) predicted++;
                else unexpected++;
            });
        }

        const report = {
            version: VERSION,
            generatedAt: Date.now(),
            totalFrees: frees.length,
            byReason,
            byBunk,
            crossRef: pre ? { predicted, unexpected } : null,
            frees   // raw list
        };

        // Console summary
        try {
            log('═══════════════════════════════════════════════════════════');
            log('POST-SOLVE FREE BLOCK FORENSICS');
            log('═══════════════════════════════════════════════════════════');
            log('Total Free blocks: ' + report.totalFrees);
            if (report.totalFrees === 0) {
                log('🎉 No Free blocks — schedule fully filled.');
            } else {
                log('--- By reason ---');
                Object.entries(byReason)
                    .sort((a, b) => b[1] - a[1])
                    .forEach(([reason, count]) => {
                        const pct = Math.round(count / report.totalFrees * 100);
                        log('  ' + count + ' (' + pct + '%) — ' + REASON_LABEL(reason) + ' [' + reason + ']');
                    });
                if (report.crossRef) {
                    log('--- Pre-flight cross-reference ---');
                    log('  Predicted by feasibility check: ' + report.crossRef.predicted);
                    log('  Unexpected (algorithm miss):    ' + report.crossRef.unexpected);
                    if (report.crossRef.unexpected > 0) {
                        log('  ↑ These Frees are candidates for Cause 3 (layout) or matcher improvements.');
                    }
                }
                log('--- Per bunk (top 10) ---');
                Object.entries(byBunk)
                    .sort((a, b) => b[1].length - a[1].length)
                    .slice(0, 10)
                    .forEach(([bunk, list]) => {
                        const reasons = [...new Set(list.map(x => x.reason))].join(', ');
                        log('  Bunk ' + bunk + ': ' + list.length + ' [' + reasons + ']');
                    });
            }
            log('═══════════════════════════════════════════════════════════');
        } catch (_) {}

        try { window._lastFreeForensicsReport = report; } catch (_) {}
        return report;
    }

    // -------------------------------------------------------------------------
    // Exports.
    // -------------------------------------------------------------------------

    const AutoFeasibility = {
        VERSION,
        check,
        forensics,
        REASON_LABEL,
        // Exposed for testing.
        _internal: {
            parseQtyOp,
            isFieldAccessibleForGrade,
            fieldHasAvailableSliceForGrade,
            fieldFullyBlockedByUnavailable,
            sliceCoveredByAvailable,
            computeUniqueSportPool,
            analyzeBunk,
            analyzeWindows,
            analyzeSpecials,
            buildRecommendations
        }
    };

    if (typeof window !== 'undefined') window.AutoFeasibility = AutoFeasibility;
    if (typeof module !== 'undefined' && module.exports) module.exports = AutoFeasibility;
})();
