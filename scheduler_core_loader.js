// ============================================================================
// scheduler_core_loader.js (GCM PATCHED FOR SMART LEAGUE ENGINE v2)
// FULL REWRITE — SPEC-COMPLIANT LOADER FOR ORCHESTRATOR V3
// ★★★ v2.1: ENHANCED buildActivityProperties with ALL field properties ★★★
// ============================================================================

(function () {
    'use strict';

    // ------------------------------------------------------------------------
    // BASIC GETTERS
    // ------------------------------------------------------------------------
    function getApp1Settings() {
        return (window.loadGlobalSettings?.() || {}).app1 || window.app1 || {};
    }

    function getSpecialActivities() {
        return (window.specialActivities || []).slice();
    }

    function getDailyOverrides() {
        return window.loadCurrentDailyData?.() || {};
    }

    // ------------------------------------------------------------------------
    // ★★★ TIME PARSING HELPER ★★★
    // ------------------------------------------------------------------------
    function parseTimeString(str) {
        if (!str || typeof str !== "string") return null;
        let s = str.trim().toLowerCase();
        let mer = null;
        if (s.endsWith("am") || s.endsWith("pm")) {
            mer = s.endsWith("am") ? "am" : "pm";
            s = s.replace(/am|pm/gi, "").trim();
        }
        const m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
        if (!m) return null;
        let hh = parseInt(m[1], 10);
        const mm = parseInt(m[2], 10);
        if (mm < 0 || mm > 59) return null;
        if (mer) {
            if (hh === 12) hh = mer === "am" ? 0 : 12;
            else if (mer === "pm") hh += 12;
        }
        return hh * 60 + mm;
    }

    // ------------------------------------------------------------------------
    // 1. BUILD MASTER ACTIVITIES
    // ------------------------------------------------------------------------
    function buildMasterActivities(app1, specials, fields) {
        let list = [];
        const seenNames = new Set();

        // 1. App-defined activities
        if (Array.isArray(app1.activities)) {
            app1.activities.forEach(a => {
                if (a && a.name && !seenNames.has(a.name)) {
                    list.push(a);
                    seenNames.add(a.name);
                }
            });
        }

        // 2. Special Activities
        if (Array.isArray(specials)) {
            specials.forEach(s => {
                if (s && s.name && !seenNames.has(s.name)) {
                    list.push({ ...s, type: s.type || 'Special' });
                    seenNames.add(s.name);
                }
            });
        }

        // 3. SPORTS FROM FIELDS (critical for league mapping)
        fields.forEach(f => {
            if (!f || !Array.isArray(f.activities)) return;
            f.activities.forEach(sportName => {
                if (sportName && !seenNames.has(sportName)) {
                    list.push({
                        name: sportName,
                        type: 'field',
                        allowedFields: [f.name]
                    });
                    seenNames.add(sportName);
                }
            });
        });

        // 4. GENERIC SLOTS
        ["General Activity Slot", "Sports Slot", "Special Activity"]
            .forEach(gen => {
                if (!seenNames.has(gen)) {
                    list.push({
                        name: gen,
                        type: "General",
                        duration: 60,
                        available: true
                    });
                    seenNames.add(gen);
                }
            });

        const defaultDurations = app1.defaultDurations || {};
        const increments = app1.increments || 30;

        return list.map(a => ({
            name: a.name,
            duration: a.duration || defaultDurations[a.name] || increments,
            type: a.type || "General",
            allowedFields: a.allowedFields || a.fields || null,
            divisions: a.divisions || null,
            ...a
        }));
    }

    // ------------------------------------------------------------------------
    // 2. TIME MAPPINGS
    // ------------------------------------------------------------------------
    function toMin(t) {
        if (!t) return 0;
        const [h, m] = t.split(":").map(Number);
        return h * 60 + m;
    }

    function buildTimeMappings(app1) {
        const increments = app1.increments || 30;
        const startMin = toMin(app1.startTime || "9:00");
        const endMin = toMin(app1.endTime || "17:00");
        const arr = [];
        let cur = startMin;

        while (cur < endMin) {
            arr.push({ start: cur, end: cur + increments });
            cur += increments;
        }
        return arr;
    }

    // ------------------------------------------------------------------------
    // 3. ACTIVITY FILTERING
    // ------------------------------------------------------------------------
    function filterActivities(masterActivities, divisionsArray) {
        return masterActivities.filter(a => {
            if (a.divisions?.length) {
                return divisionsArray.some(d => a.divisions.includes(d.name));
            }
            return true;
        });
    }

    // ------------------------------------------------------------------------
    // 4. LEGACY SCHEDULABLE BLOCKS
    // ------------------------------------------------------------------------
    function generateSchedulableBlocks(filtered, bunks, TimeMappings, increments) {
        const blocks = [];

        bunks.forEach(bunk => {
            const bunkName = typeof bunk === "string" ? bunk : bunk.name;

            filtered.forEach(act => {
                const dur = act.duration || increments;
                const slotsNeeded = Math.ceil(dur / increments);

                TimeMappings.forEach((tm, idx) => {
                    const end = idx + slotsNeeded - 1;
                    if (end < TimeMappings.length) {
                        blocks.push({
                            bunk: bunkName,
                            activity: act.name,
                            event: act.name,
                            duration: dur,
                            slots: Array.from({ length: slotsNeeded }, (_, i) => idx + i),
                            startTime: TimeMappings[idx].start,
                            endTime: TimeMappings[end].end
                        });
                    }
                });
            });
        });

        return blocks;
    }

    // ------------------------------------------------------------------------
    // 5. ★★★ ENHANCED ACTIVITY PROPERTIES (INCLUDES ALL FIELD PROPERTIES) ★★★
    // ------------------------------------------------------------------------
    function buildActivityProperties(masterActivities, fields) {
        const props = {};

        function base(over) {
            return {
                available: true,
                sharable: false,
                sharableWith: { type: "not_sharable", divisions: [], capacity: 1 },
                preferredDivisions: [],
                allowedDivisions: [],
                allowedFields: null,
                transition: null,
                preferences: null,
                limitUsage: null,
                timeRules: [],
                minDurationMin: 0,
                maxUsage: 0,
                frequencyWeeks: 0,
                rainyDayAvailable: false,
                activities: [],
                type: 'activity',
                ...over
            };
        }

        masterActivities.forEach(a => {
            props[a.name] = base({
                available: a.available !== false,
                sharable: a.sharable || false,
                sharableWith: a.sharableWith || null,
                preferredDivisions: a.divisions || [],
                allowedDivisions: a.divisions || [],
                allowedFields: a.allowedFields || null,
                transition: a.transition || null,
                preferences: a.preferences || null,
                limitUsage: a.limitUsage || null,
                timeRules: a.timeRules || [],
                minDurationMin: a.minDurationMin || 0,
                maxUsage: a.maxUsage || 0,
                type: a.type || 'activity'
            });
        });

        // ★★★ ENHANCED: Include ALL field properties ★★★
        fields.forEach(f => {
            // ★ Normalize sharableWith with complete structure
            const normalizedSharable = {
                type: f.sharableWith?.type || 'not_sharable',
                divisions: Array.isArray(f.sharableWith?.divisions) ? f.sharableWith.divisions : [],
                capacity: parseInt(f.sharableWith?.capacity) || (f.sharableWith?.type === 'all' ? 999 : 1)
            };
            
            // ★ Normalize limitUsage with complete structure
            const normalizedLimitUsage = f.limitUsage ? {
                enabled: f.limitUsage.enabled === true,
                divisions: typeof f.limitUsage.divisions === 'object' ? f.limitUsage.divisions : {},
                priorityList: Array.isArray(f.limitUsage.priorityList) ? f.limitUsage.priorityList : []
            } : null;
            
            // ★ Parse timeRules to include startMin/endMin
            const parsedTimeRules = Array.isArray(f.timeRules) ? f.timeRules.map(r => ({
                type: r.type || 'Available',
                start: r.start || '',
                end: r.end || '',
                startMin: r.startMin ?? parseTimeString(r.start),
                endMin: r.endMin ?? parseTimeString(r.end)
            })) : [];

            props[f.name] = base({
                type: 'field',
                available: f.available !== false,
                sharable: normalizedSharable.type !== 'not_sharable',
                sharableWith: normalizedSharable,
                allowedDivisions: normalizedSharable.type === 'custom' ? normalizedSharable.divisions : [],
                transition: f.transition || null,
                preferences: f.preferences || null,
                limitUsage: normalizedLimitUsage,
                timeRules: parsedTimeRules,
                // ★★★ NEW: Include rainyDayAvailable ★★★
                rainyDayAvailable: f.rainyDayAvailable === true,
                // ★★★ NEW: Include activities array (sports this field supports) ★★★
                activities: Array.isArray(f.activities) ? f.activities : []
            });
        });

        return props;
    }

    // ------------------------------------------------------------------------
    // 6. FIELDS BY SPORT  (GCM LEAGUE FIX)
    // ------------------------------------------------------------------------
    function buildFieldsBySport(masterActivities, fields) {
        const map = {};

        // Initialize every sport key so leagues never see undefined
        masterActivities.forEach(a => {
            if (a?.name) map[a.name] = [];
        });

        // Map field.activities
        fields.forEach(f => {
            if (!f?.activities) return;
            f.activities.forEach(sport => {
                if (!map[sport]) map[sport] = [];
                map[sport].push(f.name);
            });
        });

        return map;
    }

    // ------------------------------------------------------------------------
    // 7. H2H / LEAGUE NAMES
    // ------------------------------------------------------------------------
    function buildH2HActivities(masterActivities) {
        return masterActivities.filter(a => /league/i.test(a.type)).map(a => a.name);
    }

    // ------------------------------------------------------------------------
    // 8. MAIN DATA LOADER
    // ------------------------------------------------------------------------
    function loadAndFilterData() {
        const app1 = getApp1Settings();
        const bunks = app1.bunks || [];
        const fields = app1.fields || [];
        const specials = getSpecialActivities();

        const rawDivs = app1.divisions || {};
        const divisionsArray = Array.isArray(rawDivs)
            ? rawDivs
            : Object.keys(rawDivs).map(name => ({ name, ...rawDivs[name] }));

        const dailyOverrides = getDailyOverrides();

        const masterActivities = buildMasterActivities(app1, specials, fields);
        const TimeMappings = buildTimeMappings(app1);
        const filteredActivities = filterActivities(masterActivities, divisionsArray);
        
        const blocks = generateSchedulableBlocks(
            filteredActivities,
            bunks,
            TimeMappings,
            app1.increments || 30
        );

        const activityProperties = buildActivityProperties(masterActivities, fields);
        const fieldsBySport = buildFieldsBySport(masterActivities, fields); // REQUIRED FOR NEW LEAGUE ENGINE
        const h2hActivities = buildH2HActivities(masterActivities);

        const masterSpecials = masterActivities.filter(a => a.type === "Special");
        const specialActivityNames = masterSpecials.map(s => s.name);

        const divisions = divisionsArray.reduce((m, d) => {
            if (d?.name) m[d.name] = d;
            return m;
        }, {});

        // ★★★ RAINY DAY FILTERING ★★★
const isRainyMode = window.isRainyDayModeActive?.() || 
                    dailyOverrides.rainyDayMode === true || 
                    dailyOverrides.isRainyDay === true;

// Get outdoor fields to disable during rainy day
let effectiveDisabledFields = [...(dailyOverrides.disabledFields || [])];
if (isRainyMode) {
    const outdoorFields = fields
        .filter(f => f.rainyDayAvailable !== true)
        .map(f => f.name);
    effectiveDisabledFields = [...new Set([...effectiveDisabledFields, ...outdoorFields])];
    console.log(`[LoadData] 🌧️ Rainy Day Mode - Disabled ${outdoorFields.length} outdoor fields`);
}

// Filter special activities based on rainy day mode
let effectiveMasterSpecials = masterSpecials;
if (isRainyMode) {
    // Include rainy day specials, exclude activities not available on rainy days
    effectiveMasterSpecials = masterSpecials.filter(s => 
        s.rainyDayAvailable !== false && s.availableOnRainyDay !== false
    );
    
    // Add rainy-day-only specials that might have been excluded
    const rainyOnlySpecials = (window.getRainyDayActivities?.() || [])
        .filter(s => s.available !== false);
    
    // Merge without duplicates
    const existingNames = new Set(effectiveMasterSpecials.map(s => s.name));
    rainyOnlySpecials.forEach(s => {
        if (!existingNames.has(s.name)) {
            effectiveMasterSpecials.push({ ...s, type: 'Special' });
        }
    });
    
    console.log(`[LoadData] 🌧️ Rainy Day Mode - ${effectiveMasterSpecials.length} specials available`);
} else {
    // Normal day: exclude rainy-day-only activities
    effectiveMasterSpecials = masterSpecials.filter(s => 
        s.rainyDayOnly !== true && s.rainyDayExclusive !== true
    );
}

const effectiveSpecialActivityNames = effectiveMasterSpecials.map(s => s.name);

return {
    activities: filteredActivities,
    blocks,
    divisions,
    bunks,
    fields,
    masterActivities,
    masterSpecials: effectiveMasterSpecials,  // ★ Use filtered specials
    masterFields: fields,
    activityProperties,
    allActivities: masterActivities,
    h2hActivities,
    fieldsBySport,
    masterLeagues: window.masterLeagues || {},
    masterSpecialtyLeagues: window.masterSpecialtyLeagues || {},
    disabledFields: effectiveDisabledFields,  // ★ Use effective disabled fields
    disabledSpecials: dailyOverrides.disabledSpecials || [],
            disabledLeagues: dailyOverrides.disabledLeagues || [],
            disabledSpecialtyLeagues: dailyOverrides.disabledSpecialtyLeagues || [],
            historicalCounts: window.loadHistoricalCounts?.() || {},
            yesterdayHistory: window.loadYesterdayHistory?.() || {},
            rotationHistory: window.loadRotationHistory?.() || {},
            specialActivityNames,
            dailyFieldAvailability: dailyOverrides.dailyFieldAvailability || {},
            masterZones: window.loadZones?.() || {},
            bunkMetaData: window.bunkMetaData || {},
            sportMetaData: window.sportMetaData || {}
        };
    }

    // Expose to window
    window.loadAndFilterData = loadAndFilterData;
    window.generateSchedulableBlocks = generateSchedulableBlocks;
    
    // ★★★ NEW: Expose buildActivityProperties for refresh calls ★★★
    window.buildActivityProperties = buildActivityProperties;

})();
