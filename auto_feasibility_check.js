
// =============================================================================
// auto_feasibility_check.js — FEASIBILITY PRE-CHECK MODULE v1.0
// =============================================================================
// Runs BEFORE the solver to detect provably infeasible inputs.
// Returns actionable diagnostics instead of letting the solver grind fruitlessly.
//
// Checks:
//   1. Per-bunk time budget (required durations vs available free time)
//   2. Special activity capacity vs demand (cross-grade)
//   3. Pool/swim exclusivity feasibility
//   4. Field supply vs aggregate demand per time slice
//   5. Per-special usage limits vs required placements
// =============================================================================

(function () {
    'use strict';

    const TAG = '[FeasibilityCheck]';

    function log(msg, ...args) { console.log(TAG + ' ' + msg, ...args); }
    function warn(msg, ...args) { console.warn(TAG + ' ' + msg, ...args); }

    function parseTimeToMinutes(str) {
        if (str == null) return null;
        if (typeof str === 'number') return str;
        let s = String(str).toLowerCase().trim();
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

    // =========================================================================
    // MAIN CHECK
    // =========================================================================

    /**
     * Run all feasibility checks.
     *
     * @param {Object} params
     * @param {Object} params.divisions     — window.divisions
     * @param {Array}  params.layers        — user-defined layers
     * @param {Object} params.globalSettings — from loadGlobalSettings()
     * @param {boolean} params.isRainy      — rainy day mode
     * @param {string} params.dayName       — e.g. "Monday"
     * @param {Object} params.dailyData     — current day overrides
     * @param {Object} params.allDailyData  — all saved data (for period counts)
     * @param {string} params.currentDate   — e.g. "2026-07-15"
     *
     * @returns {{ feasible: boolean, issues: Array<{severity, check, message, details}> }}
     */
    function runFeasibilityChecks(params) {
        const {
            divisions, layers, globalSettings, isRainy, dayName,
            dailyData, allDailyData, currentDate
        } = params;

        const issues = [];

        if (!layers || layers.length === 0) {
            issues.push({ severity: 'error', check: 'input', message: 'No layers provided.' });
            return { feasible: false, issues };
        }

        const fields = getFields(globalSettings);
        const specials = getSpecialActivitiesList(globalSettings);
        const dailyDisabledSpecials = (dailyData?.overrides?.disabledSpecials) || [];
        const dailyDisabledFields = (dailyData?.overrides?.disabledFields) || [];

        // Group layers by grade
        const layersByGrade = {};
        layers.forEach(l => {
            const g = l.grade || l.division;
            if (!g) return;
            if (!layersByGrade[g]) layersByGrade[g] = [];
            layersByGrade[g].push(l);
        });

        // -----------------------------------------------------------------
        // CHECK 1: Per-bunk time budget
        // -----------------------------------------------------------------
        Object.entries(divisions).forEach(([grade, div]) => {
            const bunks = div.bunks || [];
            if (bunks.length === 0) return;
            const gs = (parseTimeToMinutes(div.startTime) || 540);
            const ge = (parseTimeToMinutes(div.endTime) || 960);
            const dayLength = ge - gs;

            const gradeLayers = layersByGrade[grade] || [];

            // Sum up pinned time (layers with pinExact or ratio >= 1)
            let pinnedTime = 0;
            gradeLayers.forEach(l => {
                if (l.pinExact || computeRatio(l) >= 1) {
                    const dur = l.periodMin || l.duration || l.durationMin || (l.endMin - l.startMin) || 0;
                    pinnedTime += dur;
                }
            });

            // Sum up minimum required time for non-pinned layers
            let requiredMinTime = 0;
            const TYPE_FLOORS = { swim: 30, league: 30, special: 20, sport: 25, lunch: 20, snack: 15, dismissal: 10 };
            gradeLayers.forEach(l => {
                if (l.pinExact || computeRatio(l) >= 1) return; // already counted
                const t = (l.type || '').toLowerCase();
                const dur = l.periodMin || l.duration || l.durationMin || TYPE_FLOORS[t] || 25;
                const qty = parseQuantity(l.quantity);
                requiredMinTime += dur * qty;
            });

            const totalRequired = pinnedTime + requiredMinTime;
            if (totalRequired > dayLength) {
                issues.push({
                    severity: 'error',
                    check: 'time_budget',
                    message: `${grade}: required time (${totalRequired} min) exceeds day length (${dayLength} min).`,
                    details: {
                        grade, dayLength, pinnedTime, requiredMinTime, totalRequired,
                        deficit: totalRequired - dayLength
                    }
                });
            } else if (totalRequired > dayLength * 0.95) {
                issues.push({
                    severity: 'warning',
                    check: 'time_budget',
                    message: `${grade}: very tight schedule — ${totalRequired}/${dayLength} min (${Math.round(totalRequired/dayLength*100)}% utilized).`,
                    details: { grade, dayLength, totalRequired, slack: dayLength - totalRequired }
                });
            }
        });

        // -----------------------------------------------------------------
        // CHECK 2: Special activity capacity vs cross-grade demand
        // -----------------------------------------------------------------
        const specialDemand = {}; // { specialName: { total: N, byGrade: { grade: N } } }
        Object.entries(layersByGrade).forEach(([grade, gradeLayers]) => {
            const div = divisions[grade];
            if (!div) return;
            const bunkCount = (div.bunks || []).length;

            gradeLayers.forEach(l => {
                const t = (l.type || '').toLowerCase();
                if (t !== 'special') return;
                const name = l.event || l.name || '';
                if (!name) return;
                if (!specialDemand[name]) specialDemand[name] = { total: 0, byGrade: {} };
                const qty = parseQuantity(l.quantity) || 1;
                // Each bunk needs this special `qty` times
                specialDemand[name].total += bunkCount * qty;
                specialDemand[name].byGrade[grade] = (specialDemand[name].byGrade[grade] || 0) + bunkCount * qty;
            });
        });

        Object.entries(specialDemand).forEach(([name, demand]) => {
            // Check if special is available today
            if (dailyDisabledSpecials.includes(name)) {
                if (demand.total > 0) {
                    issues.push({
                        severity: 'error',
                        check: 'special_disabled',
                        message: `Special "${name}" is disabled today but ${demand.total} bunk-slots require it.`,
                        details: { special: name, demand: demand.total, byGrade: demand.byGrade }
                    });
                }
                return;
            }

            const cfg = specials.find(s => s.name && s.name.toLowerCase().trim() === name.toLowerCase().trim());
            if (!cfg) return;

            // Check capacity vs concurrent demand
            const capacity = cfg.sharableWith?.capacity || 1;
            const shareType = cfg.sharableWith?.type || 'not_sharable';
            const gradesNeeding = Object.keys(demand.byGrade);

            if (shareType === 'not_sharable' && gradesNeeding.length > 1) {
                // Must be used by one grade at a time — check if total demand can be sequenced
                const specialDur = cfg.duration || 30;
                const totalTimeNeeded = demand.total * specialDur;
                // Rough check: is there enough total time in the day for sequential use?
                const maxDayLen = Math.max(...Object.keys(demand.byGrade).map(g => {
                    const d = divisions[g];
                    return (parseTimeToMinutes(d?.endTime) || 960) - (parseTimeToMinutes(d?.startTime) || 540);
                }));
                if (totalTimeNeeded > maxDayLen * 0.8) {
                    issues.push({
                        severity: 'warning',
                        check: 'special_capacity',
                        message: `Special "${name}" (not sharable, capacity ${capacity}): ${demand.total} bunk-visits need ~${totalTimeNeeded} min but max day is ${maxDayLen} min.`,
                        details: { special: name, capacity, shareType, demand: demand.total, timeNeeded: totalTimeNeeded }
                    });
                }
            }

            if (shareType === 'same_division') {
                // Each grade uses it separately — check per-grade demand fits
                Object.entries(demand.byGrade).forEach(([grade, gradeCount]) => {
                    if (gradeCount > capacity) {
                        // Need multiple time slots for this grade
                        const slotsNeeded = Math.ceil(gradeCount / capacity);
                        const specialDur = cfg.duration || 30;
                        const totalTime = slotsNeeded * specialDur;
                        const dayLen = (() => {
                            const d = divisions[grade];
                            return (parseTimeToMinutes(d?.endTime) || 960) - (parseTimeToMinutes(d?.startTime) || 540);
                        })();
                        if (totalTime > dayLen * 0.5) {
                            issues.push({
                                severity: 'warning',
                                check: 'special_capacity',
                                message: `Special "${name}" for ${grade}: ${gradeCount} bunks need ${slotsNeeded} time slots (~${totalTime} min).`,
                                details: { special: name, grade, bunkCount: gradeCount, capacity, slotsNeeded }
                            });
                        }
                    }
                });
            }
        });

        // -----------------------------------------------------------------
        // CHECK 3: Pool/swim exclusivity
        // -----------------------------------------------------------------
        const swimGrades = [];
        Object.entries(layersByGrade).forEach(([grade, gradeLayers]) => {
            const hasSwim = gradeLayers.some(l => (l.type || '').toLowerCase() === 'swim');
            if (hasSwim) swimGrades.push(grade);
        });

        if (swimGrades.length > 1) {
            // Pool is exclusive per grade. Check if swim windows can be staggered.
            let minPoolStart = Infinity, maxPoolEnd = 0;
            let totalSwimDur = 0;
            swimGrades.forEach(grade => {
                const swimLayer = layersByGrade[grade].find(l => (l.type || '').toLowerCase() === 'swim');
                if (!swimLayer) return;
                const ws = swimLayer.startMin || parseTimeToMinutes(swimLayer.startTime) || 540;
                const we = swimLayer.endMin || parseTimeToMinutes(swimLayer.endTime) || 960;
                minPoolStart = Math.min(minPoolStart, ws);
                maxPoolEnd = Math.max(maxPoolEnd, we);
                const dur = swimLayer.periodMin || swimLayer.duration || swimLayer.durationMin || 30;
                totalSwimDur += dur;
            });

            const poolWindow = maxPoolEnd - minPoolStart;
            if (totalSwimDur > poolWindow) {
                issues.push({
                    severity: 'error',
                    check: 'pool_exclusivity',
                    message: `Pool: ${swimGrades.length} grades need ${totalSwimDur} min total swim but pool window is only ${poolWindow} min (${minPoolStart}-${maxPoolEnd}).`,
                    details: { swimGrades, totalSwimDur, poolWindow, minPoolStart, maxPoolEnd }
                });
            } else if (totalSwimDur > poolWindow * 0.85) {
                issues.push({
                    severity: 'warning',
                    check: 'pool_exclusivity',
                    message: `Pool: tight — ${totalSwimDur}/${poolWindow} min needed for ${swimGrades.length} grades.`,
                    details: { swimGrades, totalSwimDur, poolWindow }
                });
            }
        }

        // -----------------------------------------------------------------
        // CHECK 4: Aggregate field supply vs demand per time slice
        // -----------------------------------------------------------------
        {
            const SLICE = 15; // 15-minute granularity
            const allGrades = Object.keys(divisions);
            const minStart = Math.min(...allGrades.map(g => parseTimeToMinutes(divisions[g]?.startTime) || 540));
            const maxEnd = Math.max(...allGrades.map(g => parseTimeToMinutes(divisions[g]?.endTime) || 960));

            // Count available sport fields per time slice
            const availableFields = fields.filter(f => {
                if (!f.name) return false;
                if (dailyDisabledFields.includes(f.name)) return false;
                if (isRainy && !f.isIndoor) return false;
                return true;
            });

            const totalFieldCapacity = availableFields.reduce((sum, f) => sum + (f.capacity || 1), 0);

            // Count bunks that need sport fields per time slice
            for (let t = minStart; t < maxEnd; t += SLICE) {
                let bunksDemandingFields = 0;
                allGrades.forEach(grade => {
                    const div = divisions[grade];
                    const gs = parseTimeToMinutes(div?.startTime) || 540;
                    const ge = parseTimeToMinutes(div?.endTime) || 960;
                    if (t < gs || t >= ge) return; // grade not active

                    const bunks = div.bunks || [];
                    // Estimate: how many bunks need a field at this time?
                    // Subtract bunks doing off-field activities (swim, specials, lunch, etc.)
                    const offFieldLayers = (layersByGrade[grade] || []).filter(l => {
                        const lt = (l.type || '').toLowerCase();
                        if (!['swim', 'special', 'lunch', 'snack', 'dismissal'].includes(lt)) return false;
                        const ls = l.startMin || 0;
                        const le = l.endMin || 960;
                        return t >= ls && t < le;
                    });
                    const offFieldBunks = Math.min(bunks.length, offFieldLayers.length * (offFieldLayers[0]?.sharableWith?.capacity || 1));
                    bunksDemandingFields += Math.max(0, bunks.length - offFieldBunks);
                });

                if (bunksDemandingFields > totalFieldCapacity) {
                    issues.push({
                        severity: 'error',
                        check: 'field_supply',
                        message: `At ${formatTime(t)}: ${bunksDemandingFields} bunks need fields but only ${totalFieldCapacity} field capacity available.`,
                        details: { time: t, demand: bunksDemandingFields, supply: totalFieldCapacity }
                    });
                    break; // Only report first violation to avoid spam
                }
            }
        }

        // -----------------------------------------------------------------
        // CHECK 5: Per-special usage limits
        // -----------------------------------------------------------------
        Object.entries(specialDemand).forEach(([name, demand]) => {
            const cfg = specials.find(s => s.name && s.name.toLowerCase().trim() === name.toLowerCase().trim());
            if (!cfg || !cfg.maxUsage) return;

            const maxPerPeriod = cfg.maxUsage;
            const period = cfg.maxUsagePeriod || 'day';

            // For day period, check if demand exceeds max * number of time slots possible
            if (period === 'day') {
                Object.entries(demand.byGrade).forEach(([grade, gradeCount]) => {
                    const bunkCount = (divisions[grade]?.bunks || []).length;
                    const maxTotal = maxPerPeriod * bunkCount;
                    if (gradeCount > maxTotal) {
                        issues.push({
                            severity: 'warning',
                            check: 'usage_limit',
                            message: `Special "${name}" for ${grade}: ${gradeCount} bunk-visits requested but max ${maxPerPeriod}/day per bunk = ${maxTotal} max.`,
                            details: { special: name, grade, demanded: gradeCount, maxPerBunk: maxPerPeriod, maxTotal }
                        });
                    }
                });
            }
        });

        // -----------------------------------------------------------------
        // VERDICT
        // -----------------------------------------------------------------
        const hasErrors = issues.some(i => i.severity === 'error');
        const feasible = !hasErrors;

        if (issues.length > 0) {
            log('Pre-checks found ' + issues.length + ' issue(s):');
            issues.forEach(i => {
                const fn = i.severity === 'error' ? warn : log;
                fn('  [' + i.severity.toUpperCase() + '] ' + i.message);
            });
        } else {
            log('All pre-checks passed.');
        }

        return { feasible, issues };
    }

    // =========================================================================
    // HELPERS
    // =========================================================================

    function getFields(gs) { return (gs.app1 && gs.app1.fields) || gs.fields || []; }
    function getSpecialActivitiesList(gs) { return (gs.app1 && gs.app1.specialActivities) || []; }

    function computeRatio(layer) {
        const win = (layer.endMin || 0) - (layer.startMin || 0);
        if (win <= 0) return 1;
        const dur = layer.periodMin || layer.duration || layer.durationMin || 0;
        if (dur === 0 && win <= 30) return 1;
        return dur / win;
    }

    function parseQuantity(q) {
        if (!q) return 1;
        if (typeof q === 'number') return q;
        // quantity format: ">=3", "<=2", "=4", "3"
        const match = String(q).match(/(\d+)/);
        return match ? parseInt(match[1], 10) : 1;
    }

    function formatTime(min) {
        let h = Math.floor(min / 60), m = min % 60;
        const ap = h >= 12 ? 'pm' : 'am';
        h = h % 12 || 12;
        return h + ':' + String(m).padStart(2, '0') + ap;
    }

    // =========================================================================
    // EXPORT
    // =========================================================================

    window.AutoFeasibilityCheck = { run: runFeasibilityChecks };

})();
