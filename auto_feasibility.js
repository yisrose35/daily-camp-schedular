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
    // Per-window field-supply check (Hall's margin — global, not per-grade).
    // -------------------------------------------------------------------------
    // Previous version (v1.0) computed supply per-grade, which over-counted:
    // every grade independently saw all fields as available, so 7 grades each
    // saw e.g. 17 field-slots even though those 17 are ONE physical pool. The
    // empirical run showed 43 Frees with `0` predicted deficits — proof the
    // per-grade view missed the actual cross-grade contention.
    //
    // v1.1: compute total demand vs total supply at each slice, using whole-
    // camp accounting. Mirrors the solver's own Hall check at line ~530 in
    // auto_solver_engine.js (which prints `[Hall] Structural deficit @ X-Y:
    // demand=N fieldSupply=M deficit=K`).
    //
    // Demand model: every bunk with a sport layer contributes 1 unit of
    // demand at every slice within its operating hours. This is an UPPER
    // BOUND (a bunk doesn't actually need sports at every slice — anchors
    // fill some). The deficit it produces is the worst-case structural
    // gap. Future v1.2 will subtract predicted anchor placements for
    // tighter accuracy.
    //
    // Supply model: each physical field contributes 1 unit per slice if at
    // least one grade can use it (rainy ✓, access ✓, time rules ✓). This
    // matches the solver's `fieldSupply` count — one field = one usable
    // slot at any given moment under default same-grade-sharing semantics.
    // (Capacity > 1 only helps when multiple SAME-grade bunks share — for
    // cross-grade contention, capacity is effectively 1.)

    function analyzeWindows(opts) {
        const {
            divisions, perBunk, globalSettings,
            disabledFields, isRainy, dayStart, dayEnd
        } = opts;
        const fields = (globalSettings.app1?.fields || globalSettings.fields || []);
        const disabledSet = new Set(disabledFields || []);
        const allGrades = Array.from(new Set(Object.values(perBunk).map(b => b.grade)));

        const SLICE = 30;
        const out = [];

        for (let t = dayStart; t < dayEnd; t += SLICE) {
            const sEnd = t + SLICE;

            // Global demand: sum across all bunks needing sports whose
            // operating-day covers this slice. Track per-grade breakdown
            // for diagnostics.
            const demandByGrade = {};
            let totalDemand = 0;
            for (const b of Object.values(perBunk)) {
                if (b.sportSlotsNeeded === 0) continue;
                if (t >= b.dayEnd || sEnd <= b.dayStart) continue;
                demandByGrade[b.grade] = (demandByGrade[b.grade] || 0) + 1;
                totalDemand++;
            }

            // Global supply: count physical fields usable at this slice by
            // ANY grade. Capacity > 1 doesn't help cross-grade contention,
            // so we count 1 per field (matching solver's fieldSupply).
            let totalSupply = 0;
            const supplyByGrade = {};
            for (const f of fields) {
                if (!f || !f.name) continue;
                if (disabledSet.has(f.name)) continue;
                if (isRainy && !f.isIndoor) continue;
                let usableByAnyGrade = false;
                for (const grade of allGrades) {
                    if (!isFieldAccessibleForGrade(f, grade)) continue;
                    if (!fieldHasAvailableSliceForGrade(f, grade)) continue;
                    if (!sliceCoveredByAvailable(f, grade, t, sEnd)) continue;
                    supplyByGrade[grade] = (supplyByGrade[grade] || 0) + 1;
                    usableByAnyGrade = true;
                }
                if (usableByAnyGrade) totalSupply++;
            }

            const deficit = Math.max(0, totalDemand - totalSupply);
            if (deficit > 0) {
                out.push({
                    startMin: t, endMin: sEnd,
                    totalDemand, totalSupply, deficit,
                    demandByGrade, supplyByGrade,
                    // Legacy field — keep for tests that look at hallDeficit.
                    hallDeficit: { _global: deficit }
                });
            }
        }
        return out;
    }

    // -------------------------------------------------------------------------
    // Per-grade swim feasibility — does the grade's swim window contain
    // enough free bell-schedule periods to seat every bunk?
    // -------------------------------------------------------------------------
    // The empirical run showed every iteration log this:
    //   [Phase2.3] ✗ Trios 1-6 — no free slot for staggered swim
    //   [Phase3] CSP: could not place swim/Swim for bunk Trios X
    // 6 bunks all failing means Trios's swim window has fewer viable
    // 40-min periods than 6. That's a structural infeasibility the
    // pre-flight should surface BEFORE the iteration loop wastes 13
    // attempts on it.
    //
    // For each grade with a swim layer:
    //   1. Compute the swim window after intersection with division hours.
    //   2. Find candidate bell-schedule periods within the window that are
    //      ≥ swim duration. (Falls back to ANY ≥ duration slot if no periods.)
    //   3. For staggered mode: need ≥ bunks_count candidates.
    //   4. For full-grade: need ≥ 1 candidate.

    function analyzeSwimFeasibility(opts) {
        const { divisions, layers, globalSettings, isRainy } = opts;
        const campPeriods = (typeof window !== 'undefined' && window.campPeriods)
            ? window.campPeriods
            : (globalSettings.campPeriods || globalSettings.app1?.campPeriods || {});

        const out = [];
        for (const layer of (layers || [])) {
            const t = (layer.type || '').toLowerCase();
            if (t !== 'swim') continue;
            const grade = layer.grade || layer.division;
            if (!grade) continue;
            const div = getDivisionRecord(divisions, grade);
            if (!div) continue;

            const bunks = Array.isArray(div.bunks) ? div.bunks.slice() : [];
            const bunkCount = bunks.length;
            if (bunkCount === 0) continue;

            const { start: gradeStart, end: gradeEnd } = getDayBounds(div);
            const winStart = Math.max(parseTime(layer.startMin ?? layer.startTime) ?? gradeStart, gradeStart);
            const winEnd   = Math.min(parseTime(layer.endMin   ?? layer.endTime)   ?? gradeEnd,   gradeEnd);
            const swimDur  = parseInt(layer.durationMin || layer.periodMin || layer.duration || 40, 10);
            const isFullGrade = layer.fullGrade === true;

            // Candidate periods — prefer bell schedule, else synthesize from window.
            let candidates = [];
            const gp = campPeriods[grade] || campPeriods[String(grade)] || null;
            if (Array.isArray(gp) && gp.length > 0) {
                for (const p of gp) {
                    const ps = p.startMin ?? parseTime(p.startTime);
                    const pe = p.endMin   ?? parseTime(p.endTime);
                    if (ps == null || pe == null) continue;
                    if (ps < winStart || pe > winEnd) continue;
                    if (pe - ps < swimDur) continue;
                    candidates.push({ startMin: ps, endMin: pe });
                }
            } else if (winEnd - winStart >= swimDur) {
                // No bell schedule — treat the window as a single big candidate.
                candidates.push({ startMin: winStart, endMin: winEnd });
            }

            // How many bunks can share one swim period? Scan the field list for
            // any field hosting a swim activity and read its sharableWith.capacity.
            // If the pool fits N bunks concurrently, we only need ceil(bunks/N)
            // distinct period slots, not one per bunk. This prevents false-positive
            // deficits when all bunks can share a single pool slot simultaneously.
            let swimPoolCap = 1;
            const allSwimFields = (globalSettings.app1?.fields || globalSettings.fields || []);
            for (const sf of allSwimFields) {
                if (!sf || !sf.name) continue;
                if (isRainy && !sf.isIndoor) continue;
                const sfActs = sf.activities || [];
                if (!sfActs.some(a => typeof a === 'string' && /swim/i.test(a))) continue;
                const sfCap = parseInt(sf.sharableWith?.capacity) || 1;
                if (sfCap > swimPoolCap) swimPoolCap = sfCap;
            }
            const needed = isFullGrade ? 1 : Math.ceil(bunkCount / swimPoolCap);
            const haveCount = candidates.length;
            const deficit = Math.max(0, needed - haveCount);
            const flagged = deficit > 0;

            out.push({
                grade: String(grade),
                bunkCount,
                swimDuration: swimDur,
                isFullGrade,
                concurrentCapacity: swimPoolCap,
                windowStart: winStart,
                windowEnd: winEnd,
                periodsInWindow: haveCount,
                periodsNeeded: needed,
                deficit,
                flagged
            });
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

    function buildRecommendations(perBunk, perWindow, perSpecial, perSwim) {
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

        // Cause 2a — per-grade swim feasibility (often the largest hidden infeasibility).
        // Surfaced separately from generic window deficits because it has a specific,
        // actionable fix (widen the window or change to fullGrade).
        for (const sw of (perSwim || [])) {
            if (!sw.flagged) continue;
            recs.push({
                severity: 'high',
                cause: 2,
                target: 'grade:' + sw.grade + ':swim',
                message: 'Grade ' + sw.grade + ' swim is infeasible: ' + sw.bunkCount +
                    ' bunk(s) need staggered ' + sw.swimDuration + '-min slots in window ' +
                    minutesToTime(sw.windowStart) + '–' + minutesToTime(sw.windowEnd) +
                    ' but only ' + sw.periodsInWindow + ' viable period(s) fit. ' +
                    'Deficit: ' + sw.deficit + ' bunk(s) will not get swim.',
                action:
                    'Widen ' + sw.grade + '\'s swim window, shorten swim duration, switch the ' +
                    'swim layer to fullGrade=true (all bunks at once), or remove ' + sw.deficit +
                    ' bunk(s) from swim today via daily-disabled.',
                detail: sw
            });
        }

        // Cause 2b — global window deficit (Hall's margin across whole camp).
        if (perWindow.length > 0) {
            // Group consecutive deficit slices into ranges for cleaner output.
            const ranges = [];
            for (const w of perWindow) {
                const last = ranges[ranges.length - 1];
                if (last && last.endMin === w.startMin && last.deficit === w.deficit) {
                    last.endMin = w.endMin;
                } else {
                    ranges.push({ startMin: w.startMin, endMin: w.endMin, deficit: w.deficit, demandByGrade: w.demandByGrade });
                }
            }
            for (const r of ranges) {
                const topGrades = Object.entries(r.demandByGrade || {})
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 3)
                    .map(([g, n]) => g + '(' + n + ')')
                    .join(', ');
                recs.push({
                    severity: 'high',
                    cause: 2,
                    target: 'window:' + r.startMin + '-' + r.endMin,
                    message: 'Camp-wide field shortage at ' +
                        minutesToTime(r.startMin) + '–' + minutesToTime(r.endMin) +
                        ': ' + r.deficit + ' more bunk-slot(s) needed than fields available' +
                        (topGrades ? ' (top demand: ' + topGrades + ')' : '') + '.',
                    action:
                        'Add a field accessible during this window, relax sharing rules to ' +
                        'allow more bunks per field, or stagger another layer so fewer bunks ' +
                        'compete for sports at this time.',
                    detail: r
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

    // Helper for human-readable time in recommendations.
    function minutesToTime(min) {
        if (min == null) return '?';
        let h = Math.floor(min / 60), m = min % 60;
        const ap = h >= 12 ? 'pm' : 'am';
        h = h % 12 || 12;
        return h + ':' + String(m).padStart(2, '0') + ap;
    }

    // -------------------------------------------------------------------------
    // Console summary — one block per generation, scannable.
    // -------------------------------------------------------------------------

    function printSummary(report) {
        log('═══════════════════════════════════════════════════════════');
        log('PRE-FLIGHT FEASIBILITY REPORT v' + VERSION);
        log('═══════════════════════════════════════════════════════════');

        const { perBunk, perWindow, perSpecial, perSwim, recommendations, summary } = report;
        const bunkCount = Object.keys(perBunk).length;
        const flagged   = Object.values(perBunk).filter(b => b.flagged).length;

        log('Bunks analyzed:    ' + bunkCount + ' (' + flagged + ' at risk for Cause 1)');
        log('Swim deficits:     ' + (summary.totalGradesWithSwimDeficit || 0) +
            ' grade(s) cannot fit swim for all bunks');
        log('Window deficits:   ' + perWindow.length + ' time slice(s) with field shortage' +
            (perWindow.length > 0 ? ' (peak: ' + (summary.windowDeficitMax || 0) + ' bunk-slot(s) short)' : ''));
        log('Specials:          ' + Object.keys(perSpecial).length + ' (' +
            Object.values(perSpecial).filter(s => s.contentionRatio > 1).length + ' contended)');
        log('Predicted min Frees: ' + summary.predictedMinFrees +
            ' (pool=' + summary.poolDeficitSum +
            ', swim=' + summary.swimDeficitSum +
            ', windowPeak=' + summary.windowDeficitMax + ')');

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

        const perSwim = analyzeSwimFeasibility({
            divisions, layers, globalSettings, isRainy
        });

        const recommendations = buildRecommendations(perBunk, perWindow, perSpecial, perSwim);

        // Predicted minimum Frees aggregates three sources:
        //   1. Per-bunk pool deficits (Cause 1)
        //   2. Per-grade swim deficits (Cause 2 — bunks that won't get swim)
        //   3. Per-window global Hall deficits (Cause 2 — peak field shortage)
        // The three can overlap, so the sum is an UPPER BOUND on predicted
        // Frees rather than a sharp prediction. The cross-check in
        // forensics() against actual Frees is what tells us if the prediction
        // is too loose or too tight.
        let poolDeficitSum = 0;
        Object.values(perBunk).forEach(b => { poolDeficitSum += b.poolDeficit; });
        const swimDeficitSum = (perSwim || []).reduce((s, x) => s + (x.deficit || 0), 0);
        const windowDeficitMax = perWindow.length > 0
            ? Math.max(...perWindow.map(w => w.deficit || 0))
            : 0;
        // Use max of (poolSum + swimSum) and windowMax — the latter is a
        // single-window peak shortage, the former is sum across bunks/grades.
        // They're different measurement axes; take whichever signals more.
        const predictedMinFrees = Math.max(poolDeficitSum + swimDeficitSum, windowDeficitMax);

        const feasible = recommendations.filter(r => r.severity === 'high').length === 0;

        const report = {
            version: VERSION,
            feasible,
            perBunk,
            perWindow,
            perSpecial,
            perSwim,
            recommendations,
            summary: {
                totalBunksAtRisk: Object.values(perBunk).filter(b => b.flagged).length,
                totalWindowsAtRisk: perWindow.length,
                totalGradesWithSwimDeficit: (perSwim || []).filter(s => s.flagged).length,
                predictedMinFrees,
                poolDeficitSum,
                swimDeficitSum,
                windowDeficitMax,
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
            // Grades whose swim window had a deficit (Cause 2a).
            const swimFlaggedGrades = new Set(
                (pre.perSwim || []).filter(s => s.flagged).map(s => String(s.grade))
            );
            // Time windows with a capacity deficit (Cause 2b).
            const deficitWindows = (pre.perWindow || []).filter(w => w.deficit > 0);

            frees.forEach(f => {
                const pb = pre.perBunk[f.bunk];
                // Cause 1: pool exhaustion flagged at bunk level.
                if (pb && pb.flagged) { predicted++; return; }
                // Cause 2a: swim window deficit for this bunk's grade.
                const grade = pb ? String(pb.grade) : null;
                if (grade && swimFlaggedGrades.has(grade)) { predicted++; return; }
                // Cause 2b: Free falls inside a pre-flight window deficit slot.
                if (f.startMin != null && deficitWindows.some(
                    w => w.startMin < (f.endMin ?? f.startMin + 1) && w.endMin > f.startMin
                )) { predicted++; return; }
                unexpected++;
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
            analyzeSwimFeasibility,
            buildRecommendations
        }
    };

    if (typeof window !== 'undefined') window.AutoFeasibility = AutoFeasibility;
    if (typeof module !== 'undefined' && module.exports) module.exports = AutoFeasibility;
})();
