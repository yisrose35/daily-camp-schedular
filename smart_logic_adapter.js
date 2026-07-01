// ============================================================================
// SmartLogicAdapter V44.1 (RAINY DAY FILTERING FIX)
// ============================================================================
// CRITICAL FIXES FROM V44:
// 1. NOW CHECKS GlobalFieldLocks for elective locks (division-aware)
// 2. When activity is locked, uses fallback instead of leaving empty
// 3. Swim/Pool interchangeability - treats them as the same resource
// 4. Better logging for lock conflicts
// ★★★ V44.1: FILTERS OUT RAINY DAY ACTIVITIES ON NORMAL DAYS ★★★
// ============================================================================

(function() {
    "use strict";

    // Cache the specials list for the duration of one solve run so
    // getAvailableSpecialsForTimeBlock doesn't call getGlobalSpecialActivities
    // (and iterate 864+ rainy-only entries) on every single block.
    let _specialsCache = null;
    let _specialsCacheRainyMode = null;
    let _validLocCache = null;   // Set of lowercased facility+field names (orphan-facility gate)
    window.invalidateSmartLogicSpecialsCache = function() { _specialsCache = null; _specialsCacheRainyMode = null; _validLocCache = null; };

    // ★ A special whose configured `location` is not a real facility/field has nowhere
    //   to be held (e.g. "Canteen"/"Gameroom" with no such facility). The scheduler's
    //   loader filters these out, but the SmartTile pre-allocator builds its pool from
    //   getAvailableSpecialsForTimeBlock, so without the same gate it keeps emitting
    //   them. Returns true if the special should be DROPPED. Fail-open: if the facility
    //   registry can't be read, the cache stays empty and nothing is dropped.
    function _specialFacilityMissing(special, props) {
        if (_validLocCache === null) {
            try {
                const facs = (typeof window.getFacilities === 'function') ? window.getFacilities() : null;
                const facNames = Array.isArray(facs) ? facs.map(f => (f && f.name) || f) : (facs ? Object.keys(facs) : []);
                const app1 = ((window.loadGlobalSettings && window.loadGlobalSettings()) || {}).app1 || {};
                const fieldNames = (app1.fields || []).map(f => (f && f.name) || f);
                const names = facNames.concat(fieldNames).filter(Boolean).map(n => String(n).trim().toLowerCase());
                _validLocCache = new Set(names);
            } catch (_e) { _validLocCache = new Set(); }
        }
        if (_validLocCache.size === 0) return false; // registry unavailable → fail open
        const loc = (props && props.location) || (special && special.location);
        if (!loc || !String(loc).trim()) return false;        // no location requirement → keep
        return !_validLocCache.has(String(loc).trim().toLowerCase());
    }

    // =========================================================================
    // STORAGE KEYS
    // =========================================================================
    
    function loadPriorityQueue() {
        const g = window.loadGlobalSettings?.() || {};
        return g.smartTilePriority || [];
    }

    function savePriorityQueue(queue) {
        window.saveGlobalSettings?.("smartTilePriority", queue);
        window.forceSyncToCloud?.();
    }

    // =========================================================================
    // HELPER FUNCTIONS
    // =========================================================================

    function parseTime(str) {
        if (!str) return 0;
        if (typeof str === 'number') return str;
        let s = str.trim().toLowerCase();
        let am = s.endsWith("am");
        let pm = s.endsWith("pm");
        s = s.replace(/am|pm/g, "").trim();
        const [h, m] = s.split(":").map(Number);
        let hh = h;
        if (pm && h !== 12) hh += 12;
        if (am && h === 12) hh = 0;
        return hh * 60 + (m || 0);
    }

    function isSame(a, b) {
        if (!a || !b) return false;
        return a.trim().toLowerCase() === b.trim().toLowerCase();
    }

    function isSpecialType(name) {
        if (!name) return false;
        const lower = name.toLowerCase().trim();
        return lower === "special" || 
               lower === "special activity" || 
               lower.includes("special");
    }

    const DEBUG_SMART_TILE = window.DEBUG_SMART_TILE || false;

    function log(...args) {
        // Read window.DEBUG_SMART_TILE LIVE so the trace can be toggled at runtime
        // (set window.DEBUG_SMART_TILE = true, then regenerate) — it was previously
        // captured once at load, so the flag could only be set before page load.
        if (window.DEBUG_SMART_TILE || DEBUG_SMART_TILE) console.log("[SmartTile]", ...args);
    }

    // =========================================================================
    // SWIM/POOL ALIAS SYSTEM
    // =========================================================================
    
    const SWIM_POOL_ALIASES = ['swim', 'pool', 'swimming', 'swimming pool'];
    
    /**
     * Check if a name refers to swim/pool
     */
    function isSwimOrPool(name) {
        if (!name) return false;
        const lower = name.toLowerCase().trim();
        return SWIM_POOL_ALIASES.some(alias => lower.includes(alias));
    }
    
    /**
     * Get canonical name for swim/pool (returns "Pool" as the canonical)
     */
    function getCanonicalSwimName(name, activityProps) {
        if (!isSwimOrPool(name)) return name;
        if (!activityProps) return name;
        
        // Find any pool-related key in activity properties
        const allKeys = Object.keys(activityProps);
        const poolKey = allKeys.find(k => isSwimOrPool(k));
        
        return poolKey || name;
    }

    // =========================================================================
    // CORE: CHECK IF DIVISION CAN USE A SPECIAL (WITH LOCK CHECK)
    // =========================================================================
    
    /**
     * Checks if a specific division is allowed to use this special activity.
     * * Checks:
     * 1. GlobalFieldLocks (elective locks)
     * 2. accessRestrictions.enabled + accessRestrictions.divisions
     * 3. preferences.exclusive + preferences.list
     * * @param {string} divisionName - The division to check
     * @param {object} props - The activity properties
     * @param {string} specialName - The name of the special activity
     * @param {number[]} slots - The slot indices to check
     * @returns {boolean} - True if division can use this special
     */
    function canDivisionUseSpecial(divisionName, props, specialName, slots) {
        if (!props) return true; // No props = no restrictions
        
        // CHECK GLOBAL FIELD LOCKS (Elective locks) - CRITICAL!
        if (window.GlobalFieldLocks && slots && slots.length > 0) {
            // Check the activity name
            let lockInfo = window.GlobalFieldLocks.isFieldLocked(specialName, slots, divisionName);
            
            // Also check swim/pool aliases
            if (!lockInfo && isSwimOrPool(specialName)) {
                for (const alias of SWIM_POOL_ALIASES) {
                    lockInfo = window.GlobalFieldLocks.isFieldLocked(alias, slots, divisionName);
                    if (lockInfo) break;
                }
            }
            
            if (lockInfo) {
                log(`    [LOCK] ${specialName} is locked for ${divisionName}: ${lockInfo.reason || lockInfo.lockedBy}`);
                return false;
            }
        }
        
        // Check accessRestrictions restrictions
        if (props.accessRestrictions?.enabled) {
            const allowedDivisions = props.accessRestrictions.divisions || {};

            // If accessRestrictions is enabled, division must be in the allowed list
            if (!(divisionName in allowedDivisions)) {
                return false;
            }
        }

        // ★ Duplicate-safe gate. `props` is resolved from ONE entry's properties,
        //   but this camp duplicates specials by case ("Sushi"/"sushi") and the
        //   duplicate may carry no restriction — so the props-based check above
        //   can miss a restriction living on the other copy. The authoritative
        //   check (scheduler_core_auto.js) considers EVERY copy of the name and
        //   fails closed. Fail-open only if it isn't loaded yet.
        if (typeof window.isSpecialAvailableForDivision === 'function'
            && !window.isSpecialAvailableForDivision(specialName, divisionName, window.loadGlobalSettings?.())) {
            return false;
        }

        // Check preferences.exclusive
        if (props.preferences?.enabled && props.preferences?.exclusive) {
            const preferredList = props.preferences.list || [];
            
            // If exclusive mode is on, division must be in the preference list
            if (!preferredList.includes(divisionName)) {
                return false;
            }
        }
        
        // Check allowedDivisions (another common pattern)
        if (props.allowedDivisions?.length > 0) {
            if (!props.allowedDivisions.includes(divisionName)) {
                return false;
            }
        }
        
        return true;
    }

    /**
     * Checks if a specific BUNK can use this special activity.
     * * Checks:
     * 1. Division-level access (via canDivisionUseSpecial)
     * 2. Bunk-level restrictions (accessRestrictions.divisions[div] array)
     * * @param {string} bunkName - The bunk to check
     * @param {string} divisionName - The division this bunk belongs to
     * @param {object} props - The activity properties
     * @param {string} specialName - The name of the special
     * @param {number[]} slots - The slot indices
     * @returns {boolean} - True if bunk can use this special
     */
    function canBunkAccessSpecial(bunkName, divisionName, props, specialName, slots) {
        if (!props) return true;
        
        // First check division-level (includes lock check)
        if (!canDivisionUseSpecial(divisionName, props, specialName, slots)) {
            return false;
        }
        
        // Then check bunk-level restrictions
        if (props.accessRestrictions?.enabled) {
            const allowedDivisions = props.accessRestrictions.divisions || {};
            const bunkRestrictions = allowedDivisions[divisionName];
            
            // If there's an array of specific bunks, check if this bunk is in it
            if (Array.isArray(bunkRestrictions) && bunkRestrictions.length > 0) {
                const bunkStr = String(bunkName);
                const bunkNum = parseInt(bunkName);
                const inList = bunkRestrictions.some(b => 
                    String(b) === bunkStr || parseInt(b) === bunkNum
                );
                
                if (!inList) {
                    return false;
                }
            }
            // If it's an empty array [], all bunks in that division are allowed
        }
        
        return true;
    }

    // =========================================================================
    // CORE: GET AVAILABLE SPECIALS WITH CAPACITY FOR A TIME BLOCK
    // =========================================================================
    
    /**
     * Returns which special activities are OPEN during [startMin, endMin]
     * AND available to the specified division.
     * * This queries:
     * 1. window.getGlobalSpecialActivities() - master list
     * 2. activityProps - for availability, time rules, capacity, restrictions
     * 3. dailyFieldAvailability - for daily overrides
     * 4. GlobalFieldLocks - for elective locks
     * ★★★ V44.1: Now filters by rainy day mode ★★★
     * * @param {number} startMin - Block start time in minutes
     * @param {number} endMin - Block end time in minutes
     * @param {string} divisionName - The division to check access for
     * @param {object} activityProps - Activity properties map
     * @param {object} dailyFieldAvailability - Daily overrides
     * @returns {{ name: string, capacity: number, maxUsage: number, remainingSlots: number }[]}
     */
    function getAvailableSpecialsForTimeBlock(startMin, endMin, divisionName, activityProps, dailyFieldAvailability) {
        // ★ Cached per solve run — invalidated by window.invalidateSmartLogicSpecialsCache()
        const isRainyMode = window.isRainyDayModeActive?.() || false;
        if (_specialsCache === null || _specialsCacheRainyMode !== isRainyMode) {
            const raw = window.getGlobalSpecialActivities?.() || [];
            _specialsCacheRainyMode = isRainyMode;
            if (!isRainyMode) {
                _specialsCache = raw.filter(s => s.rainyDayExclusive !== true && s.rainyDayOnly !== true);
            } else {
                _specialsCache = raw.filter(s => s.rainyDayAvailable !== false && s.availableOnRainyDay !== false);
            }
        }
        let allSpecials = _specialsCache;
        
        // Also check activityProperties for specials (backup source)
        const propsSpecials = [];
        if (activityProps) {
            Object.entries(activityProps).forEach(([name, props]) => {
                if (props.type === 'Special' || props.type === 'special') {
                    // ★★★ FIX V44.1: Also filter activityProps specials by rainy day status ★★★
                    if (!isRainyMode && (props.rainyDayExclusive === true || props.rainyDayOnly === true)) {
                        return; // Skip rainy-day-only on normal days
                    }
                    if (isRainyMode && (props.rainyDayAvailable === false || props.availableOnRainyDay === false)) {
                        return; // Skip non-rainy-available on rainy days
                    }
                    // ★ Case-INSENSITIVE existence check. This camp duplicates every
                    //   special cap/lowercase; activityProperties is keyed by the
                    //   lowercased activity name, so a case-sensitive `s.name === name`
                    //   never matches the proper-case config entry and injects a bogus
                    //   lowercase TWIN ("Lake" config + "lake" props) into the pool.
                    if (!allSpecials.find(s => isSame(s.name, name))) {
                        propsSpecials.push({ name, ...props });
                    }
                }
            });
        }
        
        const combinedSpecials = [...allSpecials, ...propsSpecials];
        const available = [];

        // ★ Per-date Resource disables (Daily Adjustments → Resources). A special whose
        //   facility was toggled off today is added to disabledSpecials (cascade) and its
        //   location to currentDisabledFields — neither is reflected in the global config
        //   this reads, so without this gate the SmartTile/special distribution still
        //   schedules it. (The total solver already excludes them via config.masterSpecials.)
        const _resDaily = window.loadCurrentDailyData?.() || {};
        const _disabledSpecialsSet = new Set((((_resDaily.overrides || {}).disabledSpecials) || []).map(n => String(n).toLowerCase().trim()));
        const _disabledLocSet = new Set([...(window.currentDisabledFields || []), ...(((_resDaily.overrides || {}).disabledFields) || [])].map(n => String(n).toLowerCase().trim()));

        // ★ CONFIG-LEVEL facility shut-off (Facilities tab → AVAILABLE/UNAVAILABLE switch).
        //   The PERMANENT analog of the per-date Resource disable above: the switch writes
        //   available:false onto the room's backing field entry (app1.fields, matched by
        //   name). The total solver honors it for SPORTS via canBlockFit (field props
        //   available===false → rejected), but specials are pooled by NAME and never check
        //   their HOST facility's availability — so a special hosted in a shut-off room kept
        //   getting distributed by smart tiles. Resolve each special's facility robustly
        //   (case-insensitive scan for the first dup carrying a .location — this camp
        //   duplicates specials cap/lowercase with blank-location dups) and drop it when the
        //   host room is unavailable.
        const _cfg = window.loadGlobalSettings?.() || {};
        const _unavailFieldsLc = new Set((((_cfg.app1 || {}).fields) || [])
            .filter(f => f && f.name && f.available === false)
            .map(f => String(f.name).toLowerCase().trim()));
        const _resolveHostLoc = (nm) => {
            const _nl = String(nm).toLowerCase();
            for (const _s of combinedSpecials) {
                if (_s && String(_s.name).toLowerCase() === _nl && _s.location) return _s.location;
            }
            const _p = activityProps && activityProps[nm];
            return (_p && _p.location) || (window.getLocationForActivity && window.getLocationForActivity(nm)) || '';
        };

        log(`\n  Checking specials for ${divisionName} at ${startMin}-${endMin}:`);
        log(`  Found ${combinedSpecials.length} total specials to check (after rainy day filter)`);

        // Get slots for this time block
        const slots = window.SchedulerCoreUtils?.findSlotsForRange(startMin, endMin) || [];
        
        if (slots.length === 0) {
            log(`  WARNING: No slots found for ${startMin}-${endMin}`);
        }

        combinedSpecials.forEach(special => {
            const specialName = special.name;
            const props = activityProps?.[specialName] || special;

            // 0. Skip specials whose configured facility doesn't exist (parity with the
            //    scheduler loader — Canteen/Gameroom etc. with no matching facility).
            if (_specialFacilityMissing(special, props)) {
                log(`    ❌ ${specialName}: facility "${(props && props.location) || special.location}" does not exist — skipping`);
                return;
            }

            // 0.5 Per-date Resource disable: toggling a facility off today in Resources
            //     adds the special to disabledSpecials (cascade) and its location to
            //     currentDisabledFields. The total solver honors this via config.masterSpecials;
            //     this is the parity gate for the SmartTile/special-distribution pool.
            if (_disabledSpecialsSet.has(String(specialName).toLowerCase().trim())) {
                log(`    ❌ ${specialName}: disabled today in Resources`);
                return;
            }
            {
                const _specLoc = (props && props.location) || special.location || specialName;
                if (_disabledLocSet.has(String(_specLoc).toLowerCase().trim())) {
                    log(`    ❌ ${specialName}: location "${_specLoc}" disabled today in Resources`);
                    return;
                }
            }

            // 0.6 CONFIG facility shut-off: the special's host room was toggled UNAVAILABLE
            //     in the Facilities tab (available:false on its backing field entry).
            {
                const _hostLoc = _resolveHostLoc(specialName);
                if (_hostLoc && _unavailFieldsLc.has(String(_hostLoc).toLowerCase().trim())) {
                    log(`    ❌ ${specialName}: host facility "${_hostLoc}" is shut off (Facilities → Unavailable)`);
                    return;
                }
            }

            // 1. Check if globally enabled
            if (props.available === false) {
                log(`    ❌ ${specialName}: globally disabled`);
                return;
            }

            // 2. CHECK DIVISION RESTRICTIONS + LOCKS (UPDATED!)
            if (!canDivisionUseSpecial(divisionName, props, specialName, slots)) {
                log(`    ❌ ${specialName}: NOT ALLOWED for division "${divisionName}" (restriction or lock)`);
                return;
            }

            // 3. Check daily overrides (Resources panel → per-date field availability).
            //    ★ Rules are keyed by the RESOURCE the user toggled — for a special that is
            //    its FACILITY (e.g. "Arts & Crafts Shack"), NOT the special's own name.
            //    Self-named specials (facility === name) match by name, but specials hosted
            //    in a shared room under a different name (Arts & Crafts / Leather → "Arts &
            //    Crafts Shack") only have a rule under the facility key. TWO gotchas this
            //    camp exposed: (a) every special is DUPLICATED cap/lowercase ("Arts &
            //    Crafts" + "arts & crafts") and the duplicate's own `.location` is often
            //    blank → can't trust `special.location` alone; resolve the facility by a
            //    CASE-INSENSITIVE name scan over the special list, taking the first entry
            //    that actually carries a location (same resolution getLocationForActivity /
            //    the field-lock system use). (b) a stored location's casing may differ from
            //    the rule key → match dailyFieldAvailability keys case-insensitively too.
            //    Union the name- and facility-keyed rules so a closed/limited room blocks
            //    EVERY special hosted there. (Mirrors the facility-keyed model the total
            //    solver already honors via activityProperties[facility].timeRules.)
            const _dfaRulesFor = (k) => {
                if (!k || !dailyFieldAvailability) return [];
                if (dailyFieldAvailability[k]) return dailyFieldAvailability[k];
                const _kl = String(k).toLowerCase();
                for (const _dk in dailyFieldAvailability) {
                    if (String(_dk).toLowerCase() === _kl) return dailyFieldAvailability[_dk] || [];
                }
                return [];
            };
            let _specLoc = '';
            {
                const _nl = String(specialName).toLowerCase();
                for (const _s of combinedSpecials) {
                    if (_s && String(_s.name).toLowerCase() === _nl && _s.location) { _specLoc = _s.location; break; }
                }
                if (!_specLoc) _specLoc = (props && props.location) || special.location
                    || (window.getLocationForActivity && window.getLocationForActivity(specialName)) || '';
            }
            const _nameRules = _dfaRulesFor(specialName);
            const _locRules = (_specLoc && String(_specLoc).toLowerCase() !== String(specialName).toLowerCase())
                ? _dfaRulesFor(_specLoc)
                : [];
            const dailyRules = [..._nameRules, ..._locRules];

           // 4. Check time rules (daily override takes precedence over global)
            // ★ Rainy day: bypass time rules if rainyDayAvailableAllDay is set
            const bypassTimeRules = isRainyMode && props.rainyDayAvailableAllDay === true;
            const effectiveRules = dailyRules.length > 0 ? dailyRules : (props.timeRules || []);
            
            if (effectiveRules.length > 0 && !bypassTimeRules) {
                const isOpen = checkTimeRulesForBlock(startMin, endMin, effectiveRules, slots, divisionName);
                
                if (!isOpen) {
                    log(`    ❌ ${specialName}: closed during ${startMin}-${endMin} (time rules)`);
                    return;
                }
            }
            if (bypassTimeRules && effectiveRules.length > 0) {
                log(`    🌧️ ${specialName}: bypassing ${effectiveRules.length} time rule(s) (rainy day override)`);
            }

            // 5. Calculate capacity from special_activities.js / fields.js
            let capacity = 1; // Default
            
            if (props.sharableWith?.type === 'same_division') {
                capacity = parseInt(props.sharableWith.capacity) || 2;
            } else if (props.sharableWith?.type === 'all') {
                capacity = parseInt(props.sharableWith.capacity) || 999;
            } else if (props.sharableWith?.type === 'custom') {
                capacity = parseInt(props.sharableWith.capacity) || 2;
            } else if (props.sharableWith?.capacity) {
                capacity = parseInt(props.sharableWith.capacity) || 1;
            } else if (props.sharable) {
                capacity = 2;
            }

         // ★ Rainy day capacity override
            if (isRainyMode && props.rainyDayCapacity > 0) {
                log(`    🌧️ ${specialName}: Rainy day capacity override ${capacity} → ${props.rainyDayCapacity}`);
                capacity = props.rainyDayCapacity;
            }

            log(`    ✅ ${specialName}: AVAILABLE for ${divisionName} (capacity: ${capacity})`);
            
            available.push({
                name: specialName,
                capacity: capacity,
                maxUsage: props.maxUsage || 0,
                frequencyDays: props.frequencyDays || props.frequencyWeeks || 0,
                remainingSlots: capacity,
                props: props // Keep reference for bunk-level checks
            });
        });

        // ★ CASE-DUP COLLAPSE — the actual fix for "plenty of specials free but
        //   bunks get the Swim fallback". This camp stores every special TWICE,
        //   cap + lowercase ("Lake" + "lake", "VR" + "vr", "Arts & Crafts" + "arts
        //   & crafts"). Both survive into the pool because the two sources
        //   (getGlobalSpecialActivities + activityProperties) merge case-sensitively.
        //   Two pool entries for ONE physical room then:
        //     (a) DOUBLE the apparent special capacity the pre-allocator budgets, and
        //     (b) block each other on the shared facility claim key — a room reserved
        //         under the lowercase twin reads "full" to the proper-case one (and to
        //         the very division it was reserved for), so the rotation's "Special"
        //         step finds every candidate taken and falls through to Swim while the
        //         room sits empty. Collapsing also stops the lowercase placements that
        //         evaded the case-sensitive cooldown/maxUsage ledger.
        //   Collapse is by special NAME (case-insensitive) — different specials that
        //   merely SHARE a room (e.g. "Arts & Crafts" + "Leather" → one shack) have
        //   distinct names and are never merged. Within a case-variant group keep the
        //   canonical (non-all-lowercase) name; tie-break on richer capacity.
        const _canonByLcName = new Map();
        available.forEach(a => {
            const k = String(a.name).toLowerCase().trim();
            const prev = _canonByLcName.get(k);
            if (!prev) { _canonByLcName.set(k, a); return; }
            const aUpper = a.name !== a.name.toLowerCase();
            const pUpper = prev.name !== prev.name.toLowerCase();
            let keep;
            if (aUpper !== pUpper) keep = aUpper ? a : prev;          // canonical case wins
            else keep = (a.capacity > prev.capacity) ? a : prev;       // else richer config
            _canonByLcName.set(k, keep);
        });
        const deduped = [..._canonByLcName.values()];
        if (deduped.length !== available.length) {
            log(`  ⚖️ Collapsed ${available.length - deduped.length} case-duplicate special(s) → ${deduped.length} canonical`);
        }

        const totalCap = deduped.reduce((s, a) => s + a.capacity, 0);
        log(`  TOTAL FOR ${divisionName}: ${deduped.length} specials, ${totalCap} slots`);
        return deduped;
    }

    /**
     * Check if a time block passes time rules
     */
    function checkTimeRulesForBlock(startMin, endMin, rules, slots, divisionName) {
        const myDiv = divisionName != null ? String(divisionName) : null;
        // Per-grade scoping: skip rules whose `divisions` list doesn't
        // include the current division. Empty/missing list = applies to all.
        const scoped = rules.filter(r => {
            const rDivs = Array.isArray(r.divisions) ? r.divisions.map(String) : [];
            if (rDivs.length === 0) return true;
            if (!myDiv) return true;
            return rDivs.includes(myDiv);
        });
        const parsedRules = scoped.map(r => ({
            ...r,
            startMin: parseTime(r.start) ?? r.startMin,
            endMin: parseTime(r.end) ?? r.endMin
        }));

        // ★ Case-insensitive type match (parity with the field fit-check + auto):
        //   tolerate lowercase 'available'/'unavailable' on special-activity timeRules.
        const availableRules = parsedRules.filter(r => String(r.type).toLowerCase() === "available");
        if (availableRules.length > 0) {
            const inAvailable = availableRules.some(r =>
                startMin >= r.startMin && endMin <= r.endMin
            );
            if (!inAvailable) return false;
        }

        const unavailableRules = parsedRules.filter(r => String(r.type).toLowerCase() === "unavailable");
        for (const rule of unavailableRules) {
            if (startMin < rule.endMin && endMin > rule.startMin) {
                return false;
            }
        }

        return true;
    }

    /**
     * Calculate total capacity for available specials
     */
    function getTotalSpecialCapacity(availableSpecials) {
        return availableSpecials.reduce((sum, s) => sum + s.capacity, 0);
    }

    // =========================================================================
    // CORE: CHECK IF BUNK CAN USE A SPECIFIC SPECIAL (UPDATED)
    // =========================================================================

    /**
     * Checks if a bunk can use a specific special activity.
     * * Checks:
     * 1. Bunk-level access (accessRestrictions.divisions[div] array)
     * 2. maxUsage limits from historical counts
     * 3. GlobalFieldLocks
     */
    function canBunkUseSpecial(bunk, divisionName, special, historicalCounts, activityProps, slots) {
        const props = activityProps?.[special.name] || special.props || special;
        
        // Check bunk-level access restrictions (includes lock check)
        if (!canBunkAccessSpecial(bunk, divisionName, props, special.name, slots)) {
            log(`      ${bunk}: not allowed to use ${special.name} (bunk restriction or lock)`);
            return false;
        }
        
       // ★ Per-grade cap: grade-specific override takes precedence over global
        const props2 = activityProps?.[special.name] || special.props || special;
        let maxUsage = special.maxUsage || 0;
        if (divisionName && props2.maxUsagePerGrade && props2.maxUsagePerGrade[divisionName] > 0) {
            maxUsage = props2.maxUsagePerGrade[divisionName];
        }

        const _gpc = window.SchedulerCoreUtils?.getPeriodActivityCount;
        const maxPeriod = props2.maxUsagePeriod || 'half';
        const usedCount = (_gpc && maxUsage > 0) ? _gpc(bunk, special.name, maxPeriod) : ((historicalCounts[bunk] || {})[special.name] || 0);

        if (maxUsage > 0 && usedCount >= maxUsage) {
            log(`      ${bunk}: maxed out ${special.name} (${usedCount}/${maxUsage}${divisionName ? ' for ' + divisionName : ''})`);
            return false;
        }

        // ★ Exact frequency: ceiling enforcement
        let exactFreq = props2.exactFrequency || 0;
        if (divisionName && props2.exactFrequencyPerGrade && props2.exactFrequencyPerGrade[divisionName] > 0) {
            exactFreq = props2.exactFrequencyPerGrade[divisionName];
        }
        if (exactFreq > 0) {
            const exactPeriod = props2.exactFrequencyPeriod || '1week';
            const exactCount = _gpc ? _gpc(bunk, special.name, exactPeriod) : usedCount;
            if (exactCount >= exactFreq) {
                log(`      ${bunk}: at exact limit for ${special.name} (${exactCount}/${exactFreq}${divisionName ? ' for ' + divisionName : ''})`);
                return false;
            }
        }
        
        // ★ v3.5: Multi-Part check — Part 2 requires Part 1 completion
        if (window.isBunkEligibleForSpecial && !window.isBunkEligibleForSpecial(bunk, special.name)) {
            log(`      ${bunk}: blocked from ${special.name} (hasn't completed Part 1)`);
            return false;
        }

        // ★ Manual rotation gates — single source of truth (rotation_engine.js).
        //   Every OTHER manual special-placement path scores candidates through
        //   RotationEngine.calculateLimitScore, which hard-blocks (Infinity) a
        //   special that is inside its frequencyDays cooldown, on a disallowed
        //   availableDays weekday, inside a multiPart daysBetween gap (or past
        //   totalParts), ahead of its rotationCohort minimum, or over its
        //   maxUsage / exactFrequency ceiling. The Smart Tile selection bypassed
        //   it, so smart-placed specials ignored all of those. Re-use the same
        //   gate here so the swap path matches the rest of the builder. Fail-open
        //   (only block on an explicit Infinity) so nothing is dropped if the
        //   engine isn't loaded.
        if (window.RotationEngine && typeof window.RotationEngine.calculateLimitScore === 'function') {
            try {
                if (window.RotationEngine.calculateLimitScore(bunk, special.name, activityProps, divisionName) === Infinity) {
                    log(`      ${bunk}: blocked from ${special.name} (rotation gate: cooldown/availableDays/multiPart/cohort/ceiling)`);
                    return false;
                }
            } catch (_eGate) { /* fail-open */ }
        }

        return true;
    }

    /**
     * Find which specials a bunk can use from the available list
     */
    function getUsableSpecialsForBunk(bunk, divisionName, availableSpecials, historicalCounts, activityProps, slots) {
        return availableSpecials.filter(special => 
            special.remainingSlots > 0 && 
            canBunkUseSpecial(bunk, divisionName, special, historicalCounts, activityProps, slots)
        );
    }

    /**
     * Pick the best special for a bunk (least used by this bunk)
     */
    function pickBestSpecialForBunk(bunk, usableSpecials, historicalCounts, activityProps) {
        if (usableSpecials.length === 0) return null;
        
        const bunkHistory = historicalCounts[bunk] || {};

        // ★ FN-30 (manual): PERIOD-SCOPED floor deficit. historicalCounts is all-time
        //   cumulative; the ceilings in canBunkUseSpecial already use period-scoped
        //   getPeriodActivityCount, but the floor boost previously used the all-time
        //   count — so once a bunk's lifetime count passed the floor the boost died,
        //   and a bunk sitting at 0 in a FRESH period never got re-prioritized. Compute
        //   the min/exact shortage from the period count (each on its own period) so the
        //   escalation re-fires every period. Precomputed once per special (not inside
        //   the comparator) to avoid O(n log n) getPeriodActivityCount scans.
        const _gpc = window.SchedulerCoreUtils?.getPeriodActivityCount;
        const _floorEsc = {}; // special name -> escalation bonus from period-scoped floor deficit
        usableSpecials.forEach(sp => {
            const props = activityProps?.[sp.name] || sp;
            const minF = parseInt(props.minFrequency) || 0;
            const exactF = parseInt(props.exactFrequency) || 0;
            if (minF <= 0 && exactF <= 0) { _floorEsc[sp.name] = 0; return; }
            const allTime = bunkHistory[sp.name] || 0;
            const minP = (props.minFrequencyPeriod === 'week' ? '1week' : props.minFrequencyPeriod) || '1week';
            const exactP = props.exactFrequencyPeriod || '1week';
            const minCnt = minF > 0 ? (_gpc ? _gpc(bunk, sp.name, minP) : allTime) : 0;
            const exactCnt = exactF > 0 ? (_gpc ? _gpc(bunk, sp.name, exactP) : allTime) : 0;
            const minShort = minF > 0 ? Math.max(minF - minCnt, 0) : 0;
            const exactShort = exactF > 0 ? Math.max(exactF - exactCnt, 0) : 0;
            let shortage, period;
            if (exactShort >= minShort) { shortage = exactShort; period = exactP; }
            else { shortage = minShort; period = minP; }
            _floorEsc[sp.name] = shortage > 0
                ? (window.SchedulerCoreUtils?.getEscalationBonus?.(period, shortage) || shortage * 100)
                : 0;
        });

        const sorted = [...usableSpecials].sort((a, b) => {
            // Base score = all-time usage (least-used-first = variety). Below-floor
            // specials get a strong negative escalation pull (period-scoped) so they
            // sort ahead of every non-floor special — floors are near-mandatory.
            const countA = bunkHistory[a.name] || 0;
            const countB = bunkHistory[b.name] || 0;
            const scoreA = countA - (_floorEsc[a.name] || 0);
            const scoreB = countB - (_floorEsc[b.name] || 0);
            if (scoreA !== scoreB) return scoreA - scoreB;
            return Math.random() - 0.5;
        });
        return sorted[0];
    }

    // =========================================================================
    // CHECK IF MAIN ACTIVITY IS LOCKED
    // =========================================================================
    
    /**
     * Check if a main activity (like Swim) is locked for a division
     */
    function isMainActivityLocked(activityName, divisionName, slots, activityProps) {
        if (!window.GlobalFieldLocks) return false;
        
        // Check the activity directly
        let lockInfo = window.GlobalFieldLocks.isFieldLocked(activityName, slots, divisionName);
        if (lockInfo) return true;
        
        // Check swim/pool aliases
        if (isSwimOrPool(activityName)) {
            const canonical = getCanonicalSwimName(activityName, activityProps);
            if (canonical !== activityName) {
                lockInfo = window.GlobalFieldLocks.isFieldLocked(canonical, slots, divisionName);
                if (lockInfo) return true;
            }
            
            // Check all aliases
            for (const alias of SWIM_POOL_ALIASES) {
                lockInfo = window.GlobalFieldLocks.isFieldLocked(alias, slots, divisionName);
                if (lockInfo) return true;
            }
        }
        
        return false;
    }

    // =========================================================================
    // PREPROCESSING: GROUP SMART TILES INTO PAIRS
    // =========================================================================

    window.SmartLogicAdapter = {

        preprocessSmartTiles(rawSkeleton, dailyAdj, specials) {
            const jobs = [];
            const byDiv = {};

            rawSkeleton.forEach(t => {
                if (t.type === 'smart') {
                    if (!byDiv[t.division]) byDiv[t.division] = [];
                    byDiv[t.division].push(t);
                }
            });

            Object.keys(byDiv).forEach(div => {
                const tiles = byDiv[div].sort((a, b) => parseTime(a.startTime) - parseTime(b.startTime));

                // ★ CONNECTED TILES: tiles the user LINKED into the same "pair group"
                //   (smartData.pairGroup) form a coordinated ROTATION. Each connected
                //   tile is emitted as its OWN job tagged with groupIndex; the rotation
                //   (scheduler_core_main) offsets each tile by its index so every bunk
                //   walks through ALL the configured options (e.g. Sports / Special /
                //   Swim), one per tile, with no option repeated across the group.
                //   Ungrouped tiles keep the classic adjacent (i, i+1) A/B pairing, so
                //   existing skeletons are unchanged.
                const groups = {};   // pairGroup -> [tiles] (time-sorted)
                const auto = [];     // ungrouped tiles
                tiles.forEach(t => {
                    const g = t.smartData && t.smartData.pairGroup;
                    if (g != null && String(g).trim() !== '' && String(g).toLowerCase() !== 'auto') {
                        (groups[g] = groups[g] || []).push(t);
                    } else {
                        auto.push(t);
                    }
                });

                const _mkBlock = t => ({ startMin: parseTime(t.startTime), endMin: parseTime(t.endTime), division: div });
                const _emit = (A, B, extra) => {
                    const sd = A.smartData || {};
                    jobs.push(Object.assign({
                        division: div,
                        main1: sd.main1, main2: sd.main2,
                        fallbackFor: sd.fallbackFor, fallbackActivity: sd.fallbackActivity,
                        guaranteeSwap: !!sd.guaranteeSwap,
                        pairGroup: sd.pairGroup || null,
                        blockA: _mkBlock(A),
                        blockB: B ? _mkBlock(B) : null
                    }, extra || {}));
                    log(`Created job for ${div} [group ${sd.pairGroup || 'auto'}${extra && extra.groupIndex != null ? ' #' + extra.groupIndex : ''}]: ${sd.main1}/${sd.main2}`);
                };

                // Connected groups → how the user wants the linked tiles handled:
                //   • guaranteeSwap + EXACTLY 2 tiles → emit as ONE A/B pair so the
                //     hard guaranteed-swap pre-pass runs on the user-CHOSEN pair.
                //     This is how you guarantee-swap two tiles that AREN'T adjacent
                //     by time (e.g. link tile 1 ↔ tile 3 via the same pair group);
                //     "Auto" can only pair neighbors (1&2, 3&4). blockB present →
                //     _rotationOptions() returns null → _isGuaranteedSwapPair() true.
                //   • guaranteeSwap + 3+ tiles → each tile emitted as a single-block
                //     "multiGuarantee" job sharing a group id; a dedicated pre-pass
                //     (scheduler_core_main) seats ONE special per bunk across ALL the
                //     group's periods so everyone gets a special no matter how many
                //     tiles are connected (the rest of the periods become the sport).
                //   • connected but NO guarantee → one ROTATION job per tile (each
                //     bunk walks through every option).
                Object.keys(groups).forEach(g => {
                    const gt = groups[g];
                    const wantGuarantee = gt.some(t => t.smartData && t.smartData.guaranteeSwap);
                    if (gt.length === 2 && wantGuarantee) {
                        _emit(gt[0], gt[1], { guaranteeSwap: true });   // gt is time-sorted: A = earlier, B = later
                    } else if (gt.length > 2 && wantGuarantee) {
                        const gid = div + '|' + g;
                        gt.forEach(t => _emit(t, null, { guaranteeSwap: true, multiGuarantee: true, guaranteeGroupId: gid, groupSize: gt.length }));
                    } else {
                        gt.forEach((t, idx) => _emit(t, null, { groupIndex: idx, groupSize: gt.length }));
                    }
                });
                // Ungrouped → classic 2-at-a-time A/B pairs.
                for (let i = 0; i < auto.length; i += 2) _emit(auto[i], auto[i + 1] || null, null);
            });

            return jobs;
        },

        // =====================================================================
        // MAIN ASSIGNMENT LOGIC (V44.1 - RAINY DAY FILTERING)
        // =====================================================================

        generateAssignments(bunks, job, historical = {}, specialNames = [], activityProps = {}, masterFields = [], dailyFieldAvailability = {}, yesterdayHistory = {}, sharedCapacityTracker = {}, divPreAllocation = {}) {            log("\n" + "=".repeat(70));
            log(`SMART TILE V44.1: ${job.division}`);
            log(`Main1: ${job.main1}, Main2: ${job.main2}`);
            log(`Fallback: ${job.fallbackActivity} (for ${job.fallbackFor})`);
            log(`Bunks: ${bunks.join(', ')}`);
            log(`Rainy Day Mode: ${window.isRainyDayModeActive?.() || false}`);
            log("=".repeat(70));

            const divisionName = job.division;
            const main1 = job.main1?.trim();
            const main2 = job.main2?.trim();
            const fbAct = job.fallbackActivity || "Sports";
            const fbFor = job.fallbackFor || "";

            // Get slots for checking locks
            const slotsA = window.SchedulerCoreUtils?.findSlotsForRange(job.blockA.startMin, job.blockA.endMin) || [];
            const slotsB = job.blockB ? window.SchedulerCoreUtils?.findSlotsForRange(job.blockB.startMin, job.blockB.endMin) || [] : [];

            // -----------------------------------------------------------------
            // CHECK IF MAIN ACTIVITIES ARE LOCKED (ELECTIVE)
            // -----------------------------------------------------------------
            const main1LockedA = isMainActivityLocked(main1, divisionName, slotsA, activityProps);
            const main2LockedA = isMainActivityLocked(main2, divisionName, slotsA, activityProps);
            const main1LockedB = job.blockB ? isMainActivityLocked(main1, divisionName, slotsB, activityProps) : false;
            const main2LockedB = job.blockB ? isMainActivityLocked(main2, divisionName, slotsB, activityProps) : false;

            if (main1LockedA) log(`⚠️ ${main1} is LOCKED for ${divisionName} in Block A`);
            if (main2LockedA) log(`⚠️ ${main2} is LOCKED for ${divisionName} in Block A`);
            if (main1LockedB) log(`⚠️ ${main1} is LOCKED for ${divisionName} in Block B`);
            if (main2LockedB) log(`⚠️ ${main2} is LOCKED for ${divisionName} in Block B`);

            // Determine which is the "special" and which is "open"
            let specialConfig, openAct;
            if (isSame(main1, fbFor)) {
                specialConfig = main1;
                openAct = main2;
            } else if (isSame(main2, fbFor)) {
                specialConfig = main2;
                openAct = main1;
            } else {
                specialConfig = main2;
                openAct = main1;
            }

            const needsResolution = isSpecialType(specialConfig);
            
            log(`\nConfiguration:`);
            log(`  "Special" config: ${specialConfig} (needs resolution: ${needsResolution})`);
            log(`  "Open" activity: ${openAct}`);
            log(`  Division: ${divisionName}`);

            // -----------------------------------------------------------------
            // DETERMINE EFFECTIVE ACTIVITIES FOR EACH BLOCK
            // -----------------------------------------------------------------
            // If an activity is locked, we need to use fallback or the other main
            
            function getEffectiveActivities(main1Locked, main2Locked, blockLabel) {
                if (main1Locked && main2Locked) {
                    log(`  ${blockLabel}: BOTH mains locked! Using fallback for all.`);
                    return { special: null, open: fbAct, allFallback: true };
                }
                if (main1Locked) {
                    log(`  ${blockLabel}: ${main1} locked, using ${main2} as open activity`);
                    return { special: specialConfig === main1 ? null : specialConfig, open: main2, oneLocked: main1 };
                }
                if (main2Locked) {
                    log(`  ${blockLabel}: ${main2} locked, using ${main1} as open activity`);
                    return { special: specialConfig === main2 ? null : specialConfig, open: main1, oneLocked: main2 };
                }
                return { special: specialConfig, open: openAct, allFallback: false };
            }

            const effectiveA = getEffectiveActivities(main1LockedA, main2LockedA, "Block A");
            const effectiveB = job.blockB ? getEffectiveActivities(main1LockedB, main2LockedB, "Block B") : null;

            // -----------------------------------------------------------------
            // STEP 1: Get available specials for BLOCK A (DIVISION-FILTERED!)
            // -----------------------------------------------------------------
            log("\n--- BLOCK A: QUERYING AVAILABLE SPECIALS FOR " + divisionName + " ---");
            
            let specialsBlockA = [];
            if (!effectiveA.allFallback && effectiveA.special) {
                specialsBlockA = getAvailableSpecialsForTimeBlock(
                    job.blockA.startMin, 
                    job.blockA.endMin,
                    divisionName,
                    activityProps, 
                    dailyFieldAvailability
                );
                
                if (!needsResolution && effectiveA.special) {
                    specialsBlockA = specialsBlockA.filter(s => isSame(s.name, effectiveA.special));
                }
            }
            
           // ★ V44.3: Subtract slots already claimed by other divisions this run
            specialsBlockA.forEach(s => {
                const key = `${s.name}|${job.blockA.startMin}|${job.blockA.endMin}`;
                const alreadyUsed = sharedCapacityTracker[key] || 0;
                if (alreadyUsed > 0) {
                    log(`    ↘ ${s.name} Block A: capacity ${s.capacity} → ${Math.max(0, s.capacity - alreadyUsed)} (${alreadyUsed} used by other grades)`);
                    s.capacity = Math.max(0, s.capacity - alreadyUsed);
                    s.remainingSlots = s.capacity;
                }
            });
            const capacityA = getTotalSpecialCapacity(specialsBlockA);
            log(`Block A capacity for ${divisionName}: ${capacityA} slots from ${specialsBlockA.map(s => `${s.name}(${s.capacity})`).join(', ') || 'none'}`);
            // -----------------------------------------------------------------
            // STEP 2: Get available specials for BLOCK B (DIVISION-FILTERED!)
            // -----------------------------------------------------------------
            let specialsBlockB = [];
            let capacityB = 0;
            
            if (job.blockB && effectiveB && !effectiveB.allFallback && effectiveB.special) {
                log("\n--- BLOCK B: QUERYING AVAILABLE SPECIALS FOR " + divisionName + " ---");
                
                specialsBlockB = getAvailableSpecialsForTimeBlock(
                    job.blockB.startMin, 
                    job.blockB.endMin,
                    divisionName,
                    activityProps, 
                    dailyFieldAvailability
                );
                
                if (!needsResolution && effectiveB.special) {
                    specialsBlockB = specialsBlockB.filter(s => isSame(s.name, effectiveB.special));
                }
                
               // ★ V44.3: Subtract slots already claimed by other divisions this run
                specialsBlockB.forEach(s => {
                    const key = `${s.name}|${job.blockB.startMin}|${job.blockB.endMin}`;
                    const alreadyUsed = sharedCapacityTracker[key] || 0;
                    if (alreadyUsed > 0) {
                        log(`    ↘ ${s.name} Block B: capacity ${s.capacity} → ${Math.max(0, s.capacity - alreadyUsed)} (${alreadyUsed} used by other grades)`);
                        s.capacity = Math.max(0, s.capacity - alreadyUsed);
                        s.remainingSlots = s.capacity;
                    }
                });
                capacityB = getTotalSpecialCapacity(specialsBlockB);
                log(`Block B capacity for ${divisionName}: ${capacityB} slots from ${specialsBlockB.map(s => `${s.name}(${s.capacity})`).join(', ') || 'none'}`);            }

            // -----------------------------------------------------------------
            // STEP 3: Pre-screen bunks for eligibility
            // -----------------------------------------------------------------
            log("\n--- ELIGIBILITY CHECK ---");
            
            const eligibleBunks = [];
            const ineligibleBunks = [];

            const allAvailableNames = new Set([
                ...specialsBlockA.map(s => s.name),
                ...specialsBlockB.map(s => s.name)
            ]);
            
            const allAvailableSpecials = [];
            allAvailableNames.forEach(name => {
                const fromA = specialsBlockA.find(s => s.name === name);
                const fromB = specialsBlockB.find(s => s.name === name);
                allAvailableSpecials.push(fromA || fromB);
            });

            // Combine slots for eligibility check
            const allSlots = [...slotsA, ...slotsB];

            bunks.forEach(bunk => {
                const usable = allAvailableSpecials.filter(s => 
                    canBunkUseSpecial(bunk, divisionName, s, historical, activityProps, allSlots)
                );
                
                if (usable.length > 0) {
                    eligibleBunks.push(bunk);
                    log(`  ${bunk}: ELIGIBLE (can use: ${usable.map(s => s.name).join(', ')})`);
                } else {
                    ineligibleBunks.push(bunk);
                    log(`  ${bunk}: INELIGIBLE (maxed out, restricted, or locked)`);
                }
            });

            // -----------------------------------------------------------------
            // STEP 4: Sort eligible bunks by fairness
            // -----------------------------------------------------------------
            log("\n--- SORTING BY FAIRNESS ---");
            
            const priorityQueue = loadPriorityQueue();
            const divPriority = priorityQueue[divisionName] || [];

            function getSpecialUsageCount(bunk) {
                // ★ Within-division fairness = specials this bunk has had THIS PERIOD (default
                //   this week), not lifetime — matches the cross-division need-first ordering so
                //   a bunk well-served earlier doesn't stay deprioritized all week. Kill switch
                //   window.__smartTileNeedFirst = false → lifetime (legacy). Period tunable via
                //   window.__smartTileNeedPeriod (default '1week').
                // ★ PERF: reuse the ONE memoized period count exposed by scheduler_core_main
                //   instead of re-scanning history here. This runs inside sort comparators —
                //   calling getPeriodActivityCount per comparator blew generation up to ~45s.
                //   The shared memo caps it to one compute per bunk.
                if (window.__smartTileNeedFirst !== false && typeof window.__smartTileNeedCount === 'function') {
                    try { return window.__smartTileNeedCount(bunk); } catch (_) {}
                }
                let sum = 0;
                const bunkHist = historical[bunk] || {};
                allAvailableSpecials.forEach(s => {
                    sum += bunkHist[s.name] || 0;
                });
                return sum;
            }

            function playedYesterday(bunk) {
                const sched = yesterdayHistory.schedule?.[bunk] || [];
                if (!Array.isArray(sched)) return false;
                return sched.some(e => {
                    const act = (e?._activity || "").toLowerCase();
                    return allAvailableSpecials.some(s => s.name.toLowerCase() === act);
                });
            }

            const sortedEligible = [...eligibleBunks].sort((a, b) => {
                const pA = divPriority.includes(a) ? 1 : 0;
                const pB = divPriority.includes(b) ? 1 : 0;
                if (pA !== pB) return pB - pA;

                const usageA = getSpecialUsageCount(a);
                const usageB = getSpecialUsageCount(b);
                if (usageA !== usageB) return usageA - usageB;

                const yA = playedYesterday(a) ? 1 : 0;
                const yB = playedYesterday(b) ? 1 : 0;
                if (yA !== yB) return yA - yB;

                return Math.random() - 0.5;
            });

            log(`Sorted order: ${sortedEligible.join(', ')}`);

            // -----------------------------------------------------------------
            // STEP 5: BLOCK A ASSIGNMENT
            // -----------------------------------------------------------------
            log("\n--- BLOCK A ASSIGNMENT ---");
            
            const block1 = {};
            const specialWinnersA = new Set();
            
            // Handle all-fallback case
            if (effectiveA.allFallback) {
                bunks.forEach(bunk => {
                    block1[bunk] = fbAct;
                    log(`  ${bunk} -> ${fbAct} (ALL LOCKED)`);
                });
           } else {
                specialsBlockA.forEach(s => s.remainingSlots = s.capacity);
                const windowKeyA = `${job.blockA.startMin}|${job.blockA.endMin}`;

                sortedEligible.forEach(bunk => {
                    const preAlloc = divPreAllocation[bunk]?.[windowKeyA];

                    if (preAlloc?.result === 'special' && preAlloc.specialName) {
                        // Pre-allocation said this bunk gets a specific special
                        block1[bunk] = preAlloc.specialName;
                        specialWinnersA.add(bunk);
                        log(`  ${bunk} -> ${preAlloc.specialName} ⭐ (pre-allocated)`);
                    } else if (preAlloc?.result === 'fallback') {
                        // Pre-allocation said fallback
                        block1[bunk] = effectiveA.open;
                        log(`  ${bunk} -> ${effectiveA.open} (pre-alloc: fallback)`);
                    } else {
                        // No pre-allocation entry — fall back to original logic
                        const usable = getUsableSpecialsForBunk(bunk, divisionName, specialsBlockA, historical, activityProps, slotsA);
                        if (usable.length > 0) {
                            const chosen = pickBestSpecialForBunk(bunk, usable, historical);
                            if (chosen) {
                                block1[bunk] = chosen.name;
                                specialWinnersA.add(bunk);
                                chosen.remainingSlots--;
                                log(`  ${bunk} -> ${chosen.name} ⭐ (fallback logic)`);
                            } else {
                                block1[bunk] = effectiveA.open;
                                log(`  ${bunk} -> ${effectiveA.open}`);
                            }
                        } else {
                            block1[bunk] = effectiveA.open;
                            log(`  ${bunk} -> ${effectiveA.open} (no capacity)`);
                        }
                    }
                });
               ineligibleBunks.forEach(bunk => {
                    block1[bunk] = effectiveA.open;
                    log(`  ${bunk} -> ${effectiveA.open} (INELIGIBLE)`);
                });
            }
// ★★★ FULL GRADE CHECK FOR BLOCK A ★★★
            if (!effectiveA.allFallback) {
                const fullGradeActA = Object.values(block1).find(act => {
                    if (!act) return false;
                    return window.isFullGradeForDivision ? window.isFullGradeForDivision(act, job.division || '') : (activityProps[act]?.fullGrade || activityProps[act]?._fullGrade);
                });
                if (fullGradeActA) {
                    log(`\n  ★ FULL GRADE OVERRIDE (Block A): "${fullGradeActA}" → ALL ${bunks.length} bunks`);
                    bunks.forEach(bunk => { block1[bunk] = fullGradeActA; });
                    specialWinnersA.clear();
                    bunks.forEach(b => specialWinnersA.add(b));
                }
            }
            // ★ PREFER-MAIN1 leftover fill (Block A / tile 1) — kill-switch
            //   window.__smartTilePreferMain1=false. The cross-division pre-allocation can
            //   UNDER-fill a division's special rooms (a junior division loses the special
            //   budget under window contention), so its bunks were handed the open activity
            //   (main2 / Swim) in tile 1 while a special room sat FREE. Recompute the
            //   division's TRUE remaining capacity from the actual placements and upgrade any
            //   open-activity bunk to a still-free special it can lawfully use — so nobody
            //   gets main2/fallback in tile 1 while main1 is available. Only ever turns
            //   open→special (never the reverse); remainingSlots (net of other divisions via
            //   the V44.3 capacity subtraction) guarantees no over-allocation.
            if (!effectiveA.allFallback && window.__smartTilePreferMain1 !== false) {
                specialsBlockA.forEach(s => {
                    const used = Object.values(block1).filter(a => isSame(a, s.name)).length;
                    s.remainingSlots = Math.max(0, (s.capacity || 0) - used);
                });
                // ★ LEAST-SERVED-FIRST: a free room goes to the bunk with the FEWEST
                //   specials so far — yesterday's bumped-to-fallback bunks (divPriority) first,
                //   then by cumulative special usage ascending — so the SAME bunks don't grab
                //   the scarce special day after day. (sortedEligible already carries this order;
                //   re-sorting here makes it explicit and robust to upstream changes.)
                // ★ Include INELIGIBLE bunks too: STEP 3 screens eligibility against the
                //   COMBINED block A+B slots, so a bunk whose only open special is locked in
                //   its OTHER block (e.g. block B overlaps a senior division's special window)
                //   is dropped from sortedEligible — even though that special is FREE in THIS
                //   block. getUsableSpecialsForBunk re-validates against slotsA (block A only),
                //   so a genuinely-unusable bunk is still skipped; one free here is upgraded.
                [...sortedEligible, ...ineligibleBunks]
                    .filter(b => !specialWinnersA.has(b) && isSame(block1[b], effectiveA.open))
                    .sort((a, b) => {
                        const pa = divPriority.includes(a) ? 1 : 0, pb = divPriority.includes(b) ? 1 : 0;
                        if (pa !== pb) return pb - pa;
                        return getSpecialUsageCount(a) - getSpecialUsageCount(b);
                    })
                    .forEach(bunk => {
                        const usable = getUsableSpecialsForBunk(bunk, divisionName, specialsBlockA, historical, activityProps, slotsA);
                        const chosen = pickBestSpecialForBunk(bunk, usable, historical, activityProps);
                        if (chosen && chosen.remainingSlots > 0) {
                            block1[bunk] = chosen.name;
                            specialWinnersA.add(bunk);
                            chosen.remainingSlots--;
                            log(`  ${bunk} -> ${chosen.name} ⭐ (prefer-main1: filled FREE room, was ${effectiveA.open})`);
                        }
                    });
            }
            // ★ V44.3: Record Block A consumption for other divisions
            Object.entries(block1).forEach(([bunk, act]) => {
                if (!act || isSame(act, fbAct) || isSame(act, effectiveA.open)) return;
                if (specialsBlockA.some(s => isSame(s.name, act))) {
                    const key = `${act}|${job.blockA.startMin}|${job.blockA.endMin}`;
                    sharedCapacityTracker[key] = (sharedCapacityTracker[key] || 0) + 1;
                }
            });
            log(`\n  Block A Summary: ${specialWinnersA.size} got specials, ${bunks.length - specialWinnersA.size} got ${effectiveA.open || fbAct}`);

            // -----------------------------------------------------------------
            // STEP 6: BLOCK B ASSIGNMENT
            // -----------------------------------------------------------------
            const block2 = {};
            let nextDayPriority = divPriority.filter(b => !specialWinnersA.has(b));

            if (job.blockB) {
                log("\n--- BLOCK B ASSIGNMENT ---");
                
                if (effectiveB.allFallback) {
                    bunks.forEach(bunk => {
                        block2[bunk] = fbAct;
                        log(`  ${bunk} -> ${fbAct} (ALL LOCKED)`);
                    });
                } else {
                    // Reset remaining slots for Block B
                    specialsBlockB.forEach(s => s.remainingSlots = s.capacity);

                    // Winners from A get the open activity
                    log("Winners from A get OPEN activity:");
                    specialWinnersA.forEach(bunk => {
                        block2[bunk] = effectiveB.open;
                        log(`  ${bunk} -> ${effectiveB.open} (swapped)`);
                    });

                    // Losers from A try for specials
                    log("\nLosers from A try for SPECIAL:");
                    const losersFromA = sortedEligible.filter(b => !specialWinnersA.has(b));

                   const windowKeyB = `${job.blockB.startMin}|${job.blockB.endMin}`;
                    losersFromA.forEach(bunk => {
                        const preAlloc = divPreAllocation[bunk]?.[windowKeyB];

                        if (preAlloc?.result === 'special' && preAlloc.specialName) {
                            block2[bunk] = preAlloc.specialName;
                            log(`  ${bunk} -> ${preAlloc.specialName} ⭐ (pre-allocated)`);
                            nextDayPriority = nextDayPriority.filter(p => p !== bunk);
                        } else if (preAlloc?.result === 'fallback') {
                            block2[bunk] = fbAct;
                            log(`  ${bunk} -> ${fbAct} (pre-alloc: fallback)`);
                            if (!nextDayPriority.includes(bunk)) nextDayPriority.push(bunk);
                        } else {
                            // No pre-allocation — fall back to original logic
                            const usable = getUsableSpecialsForBunk(bunk, divisionName, specialsBlockB, historical, activityProps, slotsB);
                            if (usable.length > 0) {
                                const chosen = pickBestSpecialForBunk(bunk, usable, historical);
                                if (chosen) {
                                    block2[bunk] = chosen.name;
                                    chosen.remainingSlots--;
                                    log(`  ${bunk} -> ${chosen.name} ⭐ (fallback logic)`);
                                    nextDayPriority = nextDayPriority.filter(p => p !== bunk);
                                } else {
                                    block2[bunk] = fbAct;
                                    log(`  ${bunk} -> ${fbAct} (FALLBACK)`);
                                    if (!nextDayPriority.includes(bunk)) nextDayPriority.push(bunk);
                                }
                            } else {
                                block2[bunk] = fbAct;
                                log(`  ${bunk} -> ${fbAct} (FALLBACK - no usable)`);
                                if (!nextDayPriority.includes(bunk)) nextDayPriority.push(bunk);
                            }
                        }
                    });

                    ineligibleBunks.forEach(bunk => {
                        block2[bunk] = fbAct;
                        log(`  ${bunk} -> ${fbAct} (INELIGIBLE)`);
                    });
                }
// ★★★ FULL GRADE CHECK FOR BLOCK B ★★★
                if (!effectiveB.allFallback) {
                    const fullGradeActB = Object.values(block2).find(act => act && (activityProps[act]?.fullGrade || activityProps[act]?._fullGrade));
                    if (fullGradeActB) {
                        log(`\n  ★ FULL GRADE OVERRIDE (Block B): "${fullGradeActB}" → ALL ${bunks.length} bunks`);
                        bunks.forEach(bunk => { block2[bunk] = fullGradeActB; });
                    }
                }
                // ★ PREFER-MAIN1 leftover fill (Block B / tile 2): a loser-from-A sitting on
                //   the fallback (Sport) takes a still-free special in tile 2 rather than
                //   wasting the room. Winners-from-A keep their main2 (Swim) complement.
                if (!effectiveB.allFallback && window.__smartTilePreferMain1 !== false) {
                    specialsBlockB.forEach(s => {
                        const used = Object.values(block2).filter(a => isSame(a, s.name)).length;
                        s.remainingSlots = Math.max(0, (s.capacity || 0) - used);
                    });
                    // ★ LEAST-SERVED-FIRST (same as Block A): free Block-B rooms go to the
                    //   fewest-served fallback bunks so the scarce special rotates across days.
                    // ★ Include INELIGIBLE bunks (see Block A note): screened against the
                    //   combined A+B window, they may still take a special FREE in block B.
                    //   getUsableSpecialsForBunk re-validates against slotsB (block B only).
                    [...sortedEligible, ...ineligibleBunks]
                        .filter(b => !specialWinnersA.has(b) && isSame(block2[b], fbAct))
                        .sort((a, b) => {
                            const pa = divPriority.includes(a) ? 1 : 0, pb = divPriority.includes(b) ? 1 : 0;
                            if (pa !== pb) return pb - pa;
                            return getSpecialUsageCount(a) - getSpecialUsageCount(b);
                        })
                        .forEach(bunk => {
                            const usable = getUsableSpecialsForBunk(bunk, divisionName, specialsBlockB, historical, activityProps, slotsB);
                            const chosen = pickBestSpecialForBunk(bunk, usable, historical, activityProps);
                            if (chosen && chosen.remainingSlots > 0) {
                                block2[bunk] = chosen.name;
                                chosen.remainingSlots--;
                                nextDayPriority = nextDayPriority.filter(p => p !== bunk);
                                log(`  ${bunk} -> ${chosen.name} ⭐ (prefer-main1: filled FREE room in B, was ${fbAct})`);
                            }
                        });
                }
                // ★ V44.3: Record Block B consumption for other divisions
                Object.entries(block2).forEach(([bunk, act]) => {
                    if (!act || isSame(act, fbAct) || isSame(act, effectiveB?.open)) return;
                    if (specialsBlockB.some(s => isSame(s.name, act))) {
                        const key = `${act}|${job.blockB.startMin}|${job.blockB.endMin}`;
                        sharedCapacityTracker[key] = (sharedCapacityTracker[key] || 0) + 1;
                    }
                });
                const specialsInB = Object.values(block2).filter(act => 
                    specialsBlockB.some(s => s.name === act)
                ).length;
                log(`\n  Block B Summary: ${specialsInB} got specials, ${bunks.length - specialsInB} got ${effectiveB.open || fbAct}`);
            }

            // -----------------------------------------------------------------
            // STEP 7: Save priority queue
            // -----------------------------------------------------------------
            priorityQueue[divisionName] = nextDayPriority;
            savePriorityQueue(priorityQueue);
            log(`\nPriority queue for tomorrow: ${nextDayPriority.join(', ') || '(empty)'}`);

            // -----------------------------------------------------------------
            // STEP 8: Store debug info and return
            // -----------------------------------------------------------------
            window.__smartTileToday = window.__smartTileToday || {};
            window.__smartTileToday[divisionName] = {
                specialConfig,
                openAct,
                fallbackAct: fbAct,
                capacityA,
                capacityB,
                effectiveA,
                effectiveB,
                availableSpecialsA: specialsBlockA.map(s => `${s.name}(cap:${s.capacity})`),
                availableSpecialsB: specialsBlockB.map(s => `${s.name}(cap:${s.capacity})`),
                block1,
                block2,
                specialWinnersA: [...specialWinnersA],
                ineligibleBunks,
                nextDayPriority,
                rainyDayMode: window.isRainyDayModeActive?.() || false
            };

            log("\n" + "=".repeat(70));
            log("FINAL SUMMARY:");
            log(`  Block A: ${Object.entries(block1).map(([b,a]) => `${b}=${a}`).join(', ')}`);
            if (job.blockB) {
                log(`  Block B: ${Object.entries(block2).map(([b,a]) => `${b}=${a}`).join(', ')}`);
            }
            log("=".repeat(70) + "\n");

            return {
                block1Assignments: block1,
                block2Assignments: block2,
                lockedEvents: []
            };
        },

        needsGeneration(act) {
            if (!act) return false;
            const a = act.toLowerCase().trim();
            return (
                a === "sports" ||
                a === "sports slot" ||
                a === "general activity" ||
                a === "general activity slot" ||
                a === "activity"
            );
        },
        
      // Expose swim/pool helpers
        isSwimOrPool: isSwimOrPool,
        getCanonicalSwimName: getCanonicalSwimName,
        // ★ V44.3: Exposed for camp-wide budget calculation
        getAvailableSpecialsForTimeBlock: getAvailableSpecialsForTimeBlock
    };

    // =========================================================================
    // DEBUG UTILITY
    // =========================================================================

    window.debugSmartTileCapacity = function(divisionName, startMin, endMin) {
        const activityProps = window.activityProperties || {};
        const dailyData = window.loadCurrentDailyData?.() || {};
        const dailyFieldAvailability = dailyData.dailyFieldAvailability || {};
        
        console.log(`\n=== SMART TILE CAPACITY FOR ${divisionName} ===`);
        console.log(`Time: ${startMin} - ${endMin} minutes`);
        console.log(`Rainy Day Mode: ${window.isRainyDayModeActive?.() || false}`);
        
        const available = getAvailableSpecialsForTimeBlock(
            startMin, 
            endMin,
            divisionName,
            activityProps, 
            dailyFieldAvailability
        );
        
        console.log(`\nAvailable Specials for ${divisionName}:`);
        available.forEach(s => {
            console.log(`  ${s.name}: capacity=${s.capacity}, maxUsage=${s.maxUsage}`);
        });
        
        const total = available.reduce((s, a) => s + a.capacity, 0);
        console.log(`\nTOTAL CAPACITY FOR ${divisionName}: ${total}`);
        
        return available;
    };

    console.log("[SmartTile] V44.5 loaded (need-first this-week fairness; perf: shared memoized period count)");
})();
