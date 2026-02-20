// ============================================================================
// scheduler_core_loader.js (GCM PATCHED FOR SMART LEAGUE ENGINE v2.3)
// FULL REWRITE — SPEC-COMPLIANT LOADER FOR ORCHESTRATOR V3
// ★★★ v2.1: ENHANCED buildActivityProperties with ALL field properties ★★★
// ★★★ v2.2: RAINY DAY FILTERING - Indoor fields/specials only on rainy days ★★★
// ★★★ v2.3: ENHANCED DEBUG LOGGING for rainy day special tracking ★★★
// ============================================================================

(function () {
    'use strict';

    // ------------------------------------------------------------------------
    // BASIC GETTERS
    // ------------------------------------------------------------------------
    function getApp1Settings() {
        return (window.loadGlobalSettings?.() || {}).app1 || window.app1 || {};
    }

    // ★★★ v2.2: Get ALL specials (filtering happens in loadAndFilterData) ★★★
    function getSpecialActivities() {
        // Try getAllSpecialActivities first (includes both regular and rainy-day-only)
        if (typeof window.getAllSpecialActivities === 'function') {
            const all = window.getAllSpecialActivities();
            const rainyOnly = (all || []).filter(s => s.rainyDayOnly || s.rainyDayExclusive);
            console.log(`[LoadData] getSpecialActivities via getAllSpecialActivities: ${all?.length || 0} total, ${rainyOnly.length} rainy-only`);
            return all;
        }
        // Fallback: combine both arrays manually
        const regular = window.specialActivities || [];
        const rainy = window.rainyDayActivities || [];
        const combined = [...regular, ...rainy];
        console.log(`[LoadData] getSpecialActivities fallback: ${regular.length} regular + ${rainy.length} rainy = ${combined.length} total`);
        return combined;
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

        // 2. Special Activities (includes both regular and rainy-day-only)
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
                duration: null,
                availableDays: null,
                mustScheduleWhenAvailable: false,
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
                type: a.type || 'activity',
                // ★★★ v2.2: Include rainy day properties for specials ★★★
               rainyDayAvailable: a.rainyDayAvailable !== false,
                rainyDayOnly: a.rainyDayOnly === true,
                rainyDayExclusive: a.rainyDayExclusive === true,
                fullGrade: a.fullGrade === true
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
                // ★★★ v2.2: Include rainyDayAvailable for fields ★★★
                rainyDayAvailable: f.rainyDayAvailable === true,
                // ★★★ Include activities array (sports this field supports) ★★★
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
        const fieldsBySport = buildFieldsBySport(masterActivities, fields);
        const h2hActivities = buildH2HActivities(masterActivities);

        // Get all specials from master activities
        const masterSpecials = masterActivities.filter(a => 
            (a.type || '').toLowerCase() === 'special'
        );

        // ★★★ DEBUG: Log what specials we found ★★★
        const rainyOnlyInMaster = masterSpecials.filter(s => 
            s.rainyDayOnly === true || s.rainyDayExclusive === true
        );
        console.log(`[LoadData] Found ${masterSpecials.length} specials in masterActivities`);
        console.log(`[LoadData]    Rainy-day-only: ${rainyOnlyInMaster.length}`);
        if (rainyOnlyInMaster.length > 0) {
            console.log(`[LoadData]    Names: ${rainyOnlyInMaster.map(s => s.name).join(', ')}`);
        }

        const divisions = divisionsArray.reduce((m, d) => {
            if (d?.name) m[d.name] = d;
            return m;
        }, {});

        // =====================================================================
        // ★★★ v2.2: RAINY DAY FILTERING ★★★
        // =====================================================================
        const isRainyMode = window.isRainyDayModeActive?.() || 
                           dailyOverrides.rainyDayMode === true || 
                           dailyOverrides.isRainyDay === true ||
                           window.isRainyDay === true;

        // -----------------------------------------------------------------
        // STEP 1: Disable outdoor fields during rainy day
        // -----------------------------------------------------------------
        let effectiveDisabledFields = [...(dailyOverrides.disabledFields || [])];
        
        if (isRainyMode) {
            // Get all outdoor fields (those without rainyDayAvailable === true)
            const outdoorFields = fields
                .filter(f => f.rainyDayAvailable !== true)
                .map(f => f.name);
            
            // Merge with existing disabled fields (no duplicates)
            effectiveDisabledFields = [...new Set([...effectiveDisabledFields, ...outdoorFields])];
            
            // Get indoor fields for logging
            const indoorFields = fields
                .filter(f => f.rainyDayAvailable === true)
                .map(f => f.name);
            
            console.log(`[LoadData] 🌧️ RAINY DAY MODE ACTIVE`);
            console.log(`[LoadData]    Indoor fields (available): ${indoorFields.join(', ') || 'none'}`);
            console.log(`[LoadData]    Outdoor fields (disabled): ${outdoorFields.length}`);
        }

        // -----------------------------------------------------------------
        // STEP 2: Filter special activities based on rainy day mode
        // -----------------------------------------------------------------
        let effectiveMasterSpecials;
        
        if (isRainyMode) {
            // RAINY DAY: Include specials available on rainy days + rainy-day-only specials
            effectiveMasterSpecials = masterSpecials.filter(s => {
                // Exclude specials explicitly marked as NOT available on rainy days
                if (s.rainyDayAvailable === false || s.availableOnRainyDay === false) {
                    return false;
                }
                return true;
            });
            
            // Log what's available
            const rainyOnlyCount = effectiveMasterSpecials.filter(s => 
                s.rainyDayOnly === true || s.rainyDayExclusive === true
            ).length;
            const regularCount = effectiveMasterSpecials.length - rainyOnlyCount;
            
            console.log(`[LoadData]    Specials: ${effectiveMasterSpecials.length} total (${regularCount} regular, ${rainyOnlyCount} rainy-only)`);
            
        } else {
            // NORMAL DAY: Exclude rainy-day-only activities
            effectiveMasterSpecials = masterSpecials.filter(s => 
                s.rainyDayOnly !== true && s.rainyDayExclusive !== true
            );
        }

        const effectiveSpecialActivityNames = effectiveMasterSpecials.map(s => s.name);

        // ★★★ Set global flag for other modules to use ★★★
        window.currentDisabledFields = effectiveDisabledFields;

        // =====================================================================
        // ★★★ v2.2: UPDATE allActivities TO REFLECT RAINY DAY FILTERING ★★★
        // This ensures filler functions see the correct set of specials
        // =====================================================================
        const effectiveSpecialNames = new Set(effectiveMasterSpecials.map(s => s.name));
        const originalSpecialNames = new Set(masterSpecials.map(s => s.name));
        
        // Remove specials that were filtered out, add ones that were added
        let effectiveAllActivities = masterActivities.filter(a => {
            const isSpecial = (a.type || '').toLowerCase() === 'special';
            if (!isSpecial) return true; // Keep non-specials
            return effectiveSpecialNames.has(a.name); // Only keep filtered specials
        });
        
        // Add any rainy-day-only specials that might not have been in masterActivities
        effectiveMasterSpecials.forEach(s => {
            if (!effectiveAllActivities.some(a => a.name === s.name)) {
                effectiveAllActivities.push({
                    ...s,
                    type: 'Special',
                    duration: s.duration || 30
                });
                console.log(`[LoadData] ✅ Added rainy-day-only special to allActivities: ${s.name}`);
            }
        });

        // =====================================================================
        // RETURN DATA
        // =====================================================================
        return {
            activities: filteredActivities,
            blocks,
            divisions,
            bunks,
            fields,
            masterActivities: effectiveAllActivities, // ★ Use filtered version
            masterSpecials: effectiveMasterSpecials,
            masterFields: fields,
            activityProperties,
            allActivities: effectiveAllActivities, // ★ Use filtered version
            h2hActivities,
            fieldsBySport,
            masterLeagues: window.masterLeagues || {},
            masterSpecialtyLeagues: window.masterSpecialtyLeagues || {},
            disabledFields: effectiveDisabledFields,
            disabledSpecials: dailyOverrides.disabledSpecials || [],
            disabledLeagues: dailyOverrides.disabledLeagues || [],
            disabledSpecialtyLeagues: dailyOverrides.disabledSpecialtyLeagues || [],
            historicalCounts: window.loadHistoricalCounts?.() || {},
            yesterdayHistory: window.loadYesterdayHistory?.() || {},
            rotationHistory: window.loadRotationHistory?.() || {},
            specialActivityNames: effectiveSpecialActivityNames,
            dailyFieldAvailability: dailyOverrides.dailyFieldAvailability || {},
            masterZones: window.loadZones?.() || {},
            bunkMetaData: window.bunkMetaData || {},
            sportMetaData: window.sportMetaData || {},
            isRainyDayMode: isRainyMode
        };
    }

    // Expose to window
    window.loadAndFilterData = loadAndFilterData;
    window.generateSchedulableBlocks = generateSchedulableBlocks;
    window.buildActivityProperties = buildActivityProperties;

    console.log('[LOADER] v2.3 loaded - Rainy day filtering + enhanced debug logging');

})();
