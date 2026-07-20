// ============================================================================
// auto_fill_slot.js  — Smart single-slot auto-filler for the post-edit grid
// ============================================================================
// When the auto-builder leaves a Free slot, or when a user clears a cell,
// clicking "Auto Fill" on that cell runs a mini-generation just for that
// bunk: checks field availability, grade constraints, rotation history,
// daily limits, and recency penalties, then writes the best candidate.
// ============================================================================

(function () {
    'use strict';

    // ========================================================================
    // HELPERS — fall back to locally-computed values when SDK utils are absent
    // ========================================================================

    // ★ HR-34: rotation-epoch watermark reader (non-deleting half reset) —
    //   COMPLETE reset: bunks get new campers at the half, so counts, lastDone
    //   AND recency/yesterday checks all ignore dates before this dateKey.
    function _getRotationEpoch() {
        try {
            const U = window.SchedulerCoreUtils || window.Utils;
            if (U && typeof U.getRotationEpoch === 'function') return U.getRotationEpoch();
            const e = window.loadGlobalSettings ? window.loadGlobalSettings('rotationEpoch') : null;
            const d = (typeof e === 'string') ? e : (e && e.date);
            return (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) ? d : null;
        } catch (_) { return null; }
    }

    function getDivision(bunk) {
        if (window.SchedulerCoreUtils?.getDivisionForBunk) return window.SchedulerCoreUtils.getDivisionForBunk(bunk);
        const divs = window.divisions || {};
        for (const [divName, d] of Object.entries(divs)) {
            if (d.bunks?.includes(bunk)) return divName;
        }
        return null;
    }

    function getSlotInfo(divName, slotIdx, bunk) {
        const dt = window.divisionTimes?.[divName];
        if (!dt) return null;
        // Handle per-bunk slot overrides (auto-mode)
        if (dt._isPerBunk && dt._perBunkSlots) {
            const perBunk = dt._perBunkSlots[String(bunk)];
            if (perBunk?.[slotIdx]) return perBunk[slotIdx];
        }
        return dt[slotIdx] || null;
    }

    // A "Sports" tile slot (event "Sports Slot") only accepts sports; a "Special
    // Activity" slot only accepts specials; everything else is flexible ('any').
    // Mirrors slotKindOf in scheduler_core_main.js so the leftover-slot free-fill
    // and the manual ⚡ Auto Fill button respect the same sport/special boundary
    // the solver enforces.
    function slotKindOf(ev) {
        const s = String(ev || '').toLowerCase().trim();
        if (s === 'sports slot' || s === 'sport slot') return 'sport';
        if (s === 'special activity') return 'special';
        return 'any';
    }

    function getGlobalSettings() {
        return window.loadGlobalSettings?.() || {};
    }

    function isFreeEntry(entry) {
        return !entry || entry.field === 'Free' || entry._activity === 'Free' || (!entry.field && !entry._activity);
    }

    // An elective (or swim+elective hybrid) tile is a camper-choice MENU, not a
    // solver-assigned slot. STEP 2.5 of the generator (scheduler_core_main.js) only
    // RESERVES the elective's rooms — it never writes one chosen activity into each
    // bunk's cell, so the per-bunk entry stays "Free" ON PURPOSE (the bunk picks e.g.
    // Gaming Center vs Pizza Making itself). We detect it off the divisionTimes slot
    // so the ⚡ Auto Fill button skips these tiles — clicking it would clobber the menu
    // with a single auto-picked activity. Genuinely-failed empty slots (no elective
    // menu) are unaffected and still get the button.
    function isElectiveSlot(slot) {
        if (!slot) return false;
        const t = String(slot.type || '').toLowerCase();
        if (t === 'elective' || t === 'swim_elective') return true;
        return Array.isArray(slot.electiveActivities) && slot.electiveActivities.length > 0;
    }

    function toast(msg, type) {
        if (window.showToast) { window.showToast(msg, type); return; }
        const id = 'afs-toast';
        document.getElementById(id)?.remove();
        const el = document.createElement('div');
        el.id = id;
        const bg = type === 'success' ? '#16a34a' : type === 'warning' ? '#d97706' : '#dc2626';
        el.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:99999;background:${bg};color:#fff;
            padding:10px 18px;border-radius:8px;font-size:0.84rem;font-weight:600;
            box-shadow:0 4px 16px rgba(0,0,0,0.22);pointer-events:none;`;
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 3800);
    }

    // ========================================================================
    // BUILD ACTIVITY PROPERTIES MAP
    // Prefer window.activityProperties; fall back to parsing global settings.
    // ========================================================================

    function getActivityProperties() {
        if (window.activityProperties && Object.keys(window.activityProperties).length) {
            return window.activityProperties;
        }
        // Build from global settings (fallback used when window.activityProperties
        // wasn't populated by a generation this session — e.g. Auto Fill right
        // after a page reload). Must carry field time windows so Auto Fill honors
        // them the way canBlockFit does; the previous fallback omitted timeRules
        // entirely, so BOTH setup ("Available 10-12") and daily windows went
        // unchecked in this path.
        const gs = getGlobalSettings();
        const _parseTM = window.SchedulerCoreUtils?.parseTimeToMinutes;
        const _parseRules = (arr) => Array.isArray(arr) ? arr.map(r => ({
            type: r.type, available: r.available,
            startMin: (r.startMin != null) ? r.startMin : (_parseTM ? _parseTM(r.start || r.startTime) : null),
            endMin: (r.endMin != null) ? r.endMin : (_parseTM ? _parseTM(r.end || r.endTime) : null),
            divisions: Array.isArray(r.divisions) ? r.divisions : []
        })) : [];
        const map = {};
        (gs.app1?.fields || []).forEach(f => {
            map[f.name] = {
                name: f.name,
                type: 'field',
                activities: f.activities || [],
                sharableWith: f.sharableWith || f.sharing || { type: 'not_sharable', capacity: 1 },
                maxUsage: f.maxUsage || 0,
                exactFrequency: f.exactFrequency || 0,
                exactFrequencyPeriod: f.exactFrequencyPeriod || '1week',
                timeRules: _parseRules(f.timeRules),
            };
        });
        (gs.app1?.specialActivities || []).forEach(s => {
            const loc = s.location || s.name;
            map[loc] = map[loc] || {
                name: loc,
                type: 'special',
                activities: [s.name],
                sharableWith: { type: 'not_sharable', capacity: 1 },
                maxUsage: s.maxUsage || 0,
                exactFrequency: s.exactFrequency || 0,
                exactFrequencyPeriod: s.exactFrequencyPeriod || '1week',
            };
        });
        // Merge per-date Daily-Adjustments windows — they OVERRIDE the setup
        // windows for the same field (parity with the activityProperties merge
        // canBlockFit uses), keyed to the active gen/schedule date.
        try {
            const _dk = window._activeGenDate || window.currentScheduleDate || '';
            let _dfa = window.loadCurrentDailyData?.()?.dailyFieldAvailability;
            if ((!_dfa || !Object.keys(_dfa).length) && _dk) {
                const _s = localStorage.getItem('campResourceOverrides_' + _dk);
                if (_s) { const _p = JSON.parse(_s); if (_p?.dailyFieldAvailability) _dfa = _p.dailyFieldAvailability; }
            }
            if (_dfa) {
                Object.keys(_dfa).forEach(fn => {
                    const rules = _dfa[fn];
                    if (Array.isArray(rules) && rules.length) {
                        map[fn] = map[fn] || { name: fn, type: 'field', activities: [] };
                        map[fn].timeRules = _parseRules(rules);
                    }
                });
            }
        } catch (_e) {}
        return map;
    }

    // ========================================================================
    // FIELD AVAILABILITY CHECK
    // Scans scheduleAssignments for all bunks whose time overlaps our slot,
    // applies sharing/capacity rules, returns true if field has room.
    // ========================================================================

    // Returns true if the field's activityProperties.timeRules block [slotStart, slotEnd]
    // Returns true if access restrictions exclude `divName` from this field/special
    function isDivisionRestricted(item, divName) {
        const ar = item?.accessRestrictions;
        if (!ar || !ar.enabled) return false;
        const allowed = ar.divisions ? Object.keys(ar.divisions) : [];
        if (!allowed.length) return true; // restricted but no grades selected → blocked for all
        return !allowed.includes(divName);
    }

    // Core rule evaluation on a rules ARRAY — shared by the field-keyed check
    // below and the special's-own-rules gate in the candidate builder.
    function areTimeRulesBlocking(rules, slotStart, slotEnd, divName) {
        if (!Array.isArray(rules) || rules.length === 0) return false;
        const parseMin = window.SchedulerCoreUtils?.parseTimeToMinutes;
        const myDiv = divName != null ? String(divName) : null;
        let hasAvail = false, inAvail = false;
        for (const tr of rules) {
            // Skip rules scoped to other grades. A rule with `divisions: ['1']`
            // only applies to bunks in grade 1; an empty/missing list = all grades.
            const trDivs = Array.isArray(tr.divisions) ? tr.divisions.map(String) : [];
            if (trDivs.length > 0 && myDiv && !trDivs.includes(myDiv)) continue;

            const tStart = tr.startMin ?? (parseMin ? parseMin(tr.start || tr.startTime) : null);
            const tEnd   = tr.endMin   ?? (parseMin ? parseMin(tr.end   || tr.endTime)   : null);
            if (tStart == null || tEnd == null) continue;
            const type = String(tr.type || '').toLowerCase();
            const isUnavail = type === 'unavailable' || tr.available === false;
            const isAvail   = type === 'available'   || tr.available === true;
            if (isUnavail && tStart < slotEnd && tEnd > slotStart) return true;
            if (isAvail) {
                hasAvail = true;
                if (slotStart >= tStart && slotEnd <= tEnd) inAvail = true;
            }
        }
        if (hasAvail && !inAvail) return true;
        return false;
    }

    function isFieldBlockedByTimeRules(fieldName, slotStart, slotEnd, actProps, divName) {
        return areTimeRulesBlocking(actProps?.[fieldName]?.timeRules, slotStart, slotEnd, divName);
    }

    // Returns true if GlobalFieldLocks blocks this field/time/division
    function isFieldGloballyLocked(fieldName, slotStart, slotEnd, divName) {
        try {
            if (!window.GlobalFieldLocks) return false;
            if (typeof window.GlobalFieldLocks.isFieldLockedByTime === 'function') {
                const info = window.GlobalFieldLocks.isFieldLockedByTime(fieldName, slotStart, slotEnd, divName);
                return !!info;
            }
        } catch (_) {}
        return false;
    }

    // ★ Skeleton field reservations: a pinned event / league reserves a facility for a
    //   window via window.fieldReservations WITHOUT a GlobalFieldLock or a
    //   scheduleAssignments block (e.g. a "Max Leagues" pin on Slam Plex 1 @740-810 —
    //   which shows in fieldReservations but NOT in GlobalFieldLocks). canBlockFit
    //   (scheduler_core_utils.js:835) and the STEP 7.9 evict sweep both honor it; this
    //   raw-config fill path must too, or it re-fills a reserved court — leaving a real
    //   double-book (7.9, having already run, won't re-catch a post-7.9 re-heal) or a
    //   placement 7.9 later demotes to Free. Mirrors canBlockFit's check. Fail-open.
    function isFieldPinReserved(fieldName, slotStart, slotEnd) {
        try {
            const resv = window.fieldReservations;
            if (!resv || slotStart == null || slotEnd == null) return false;
            const U = window.SchedulerCoreUtils;
            if (U && typeof U.isFieldReserved === 'function') {
                return !!U.isFieldReserved(fieldName, slotStart, slotEnd, resv);
            }
        } catch (_) {}
        return false;
    }

    // Build the set of field names blocked by combos (e.g. Full Gym blocks Gym 1)
    function getComboBlockedFields(usedFieldName) {
        const out = new Set();
        try {
            const partners = window.FieldCombos?.getExclusiveFields?.(usedFieldName) || [];
            partners.forEach(p => out.add(String(p)));
        } catch (_) {}
        return out;
    }

    function isFieldAvailable(fieldName, myBunk, myDiv, slotStart, slotEnd, actProps, wantActivity) {
        const ap = actProps[fieldName] || {};
        const sharing = ap.sharableWith || ap.sharing || {};
        const sharingType = sharing.type || 'not_sharable';
        const capacity = (sharingType === 'not_sharable') ? 1 : (sharing.capacity || 1);

        let usageCount = 0;
        let sharedPlayers = 0, sharedSport = null;   // ★ player-max gate accumulators
        const sa = window.scheduleAssignments || {};
        const _bmMax = (window.getBunkMetaData && window.getBunkMetaData()) || {};

        for (const [otherBunk, slots] of Object.entries(sa)) {
            if (!Array.isArray(slots) || otherBunk === myBunk) continue;
            const otherDiv = getDivision(otherBunk);
            if (!otherDiv) continue;

            for (let i = 0; i < slots.length; i++) {
                const ot = getSlotInfo(otherDiv, i, otherBunk);
                if (!ot) continue;
                const otStart = ot.startMin ?? 0;
                const otEnd   = ot.endMin   ?? 0;
                // Time overlap test
                if (otEnd <= slotStart || otStart >= slotEnd) continue;

                const oe = slots[i];
                if (isFreeEntry(oe)) continue;

                // Extract field name from entry
                let usedField = oe._location || '';
                if (!usedField && oe.field && oe.field !== 'Free') {
                    usedField = oe.field.includes(' – ') ? oe.field.split(' – ')[0].trim()
                              : oe.field.includes(' - ') ? oe.field.split(' - ')[0].trim()
                              : oe.field;
                }
                if (!usedField) continue;

                // Combo exclusion: if a sibling bunk grabbed a combo partner, this field is taken
                if (usedField !== fieldName) {
                    const combos = getComboBlockedFields(usedField);
                    if (combos.has(fieldName)) return false;
                    continue;
                }

                // ★ Same-activity-when-sharing: a shared field/room hosts ONE activity
                //   at a time. A co-occupant doing a DIFFERENT activity means this fill
                //   can't share it — two different specials on one room (e.g. Running
                //   Bases + Off The Wall on "Football Turf"), or two different sports on
                //   one field, is a double-book even within capacity. Only enforced when
                //   the caller names the activity it intends to place.
                if (wantActivity) {
                    const _oAct = oe._activity || oe.sport || oe.activity || '';
                    if (_oAct && String(_oAct).toLowerCase().trim() !== String(wantActivity).toLowerCase().trim()) return false;
                }
                // Apply sharing rules
                if (sharingType === 'not_sharable') return false;
                if (sharingType === 'same_division' && otherDiv !== myDiv) return false;
                if (sharingType === 'custom') {
                    const allowed = sharing.divisions || [];
                    if (!allowed.includes(myDiv) || !allowed.includes(otherDiv)) return false;
                }
                usageCount++;
                // ★ accumulate combined players for the sport-max gate (this co-occupant
                //   passed the sharing rules, so its campers join the shared-game total)
                var _oActF = (oe && (oe.activity || oe.sport)) || null;
                if (_oActF) { if (!sharedSport) sharedSport = _oActF; sharedPlayers += ((_bmMax[otherBunk] && _bmMax[otherBunk].size) || 0); }
                if (usageCount >= capacity) return false;
            }
        }
        // ★ Player-max co-occupancy gate (parity with the solver's
        //   checkSharedPlayerMaxConflict): don't fill onto a SHARED field if the combined
        //   campers would exceed the sport's maxPlayers + 2 grace (e.g. Basketball max 20:
        //   two 15-bunks = 30 is rejected → the fill picks an empty court instead). Only
        //   when the field is actually shared; a lone fill onto an empty field is untouched.
        if (sharedPlayers > 0 && sharedSport) {
            var _allMetaF = (window.getSportMetaData && window.getSportMetaData()) || null;
            var _mxF = _allMetaF && _allMetaF[sharedSport] && _allMetaF[sharedSport].maxPlayers;
            if (_mxF && _mxF > 0) {
                var _mySizeF = (_bmMax[myBunk] && _bmMax[myBunk].size) || 0;
                if (sharedPlayers + _mySizeF > _mxF + 2) return false;
            }
        }
        return true;
    }

    // ========================================================================
    // BUILD CANDIDATE LIST
    // Returns all activities that are physically available for the slot.
    // ========================================================================

    function buildCandidates(bunk, slotStart, slotEnd, divName, actProps, slotKind) {
        const gs = getGlobalSettings();
        const candidates = [];
        // ★ Respect rainy day: when not raining, skip rainyOnly activities/specials.
        const isRainy = !!window.isRainyDay;
        // ★ Tile-kind gate: a Sports-only slot skips specials; a Special-only slot
        //   skips sports. 'any' (or unset) keeps both, the pre-existing behavior.
        const _kind = slotKind || 'any';

        // ★ Today's Resource disables (Daily Adjustments → Resources). The main solver
        //   already excludes these via canBlockFit / the domain build, but this fill path
        //   (the STEP 7.5 silent free-slot fallback AND the manual ⚡ Auto Fill button)
        //   iterates the RAW field/special config, so without these gates it re-fills the
        //   very fields/sports/specials the user shut off for today. Read both the gen-time
        //   global (currentDisabledFields, set during generation) and the date-fresh daily
        //   data (for the post-gen manual button). currentDisabledFields also contains
        //   special-activity LOCATIONS — disabling a facility adds its name there.
        const _curDaily = window.loadCurrentDailyData?.() || {};
        const _disabledLc = new Set([
            ...(window.currentDisabledFields || []),
            ...(((_curDaily.overrides || {}).disabledFields) || [])
        ].map(n => String(n).toLowerCase().trim()));
        const _disabledSportsByField = _curDaily.dailyDisabledSportsByField || {};
        const _disabledSpecialsLc = new Set((((_curDaily.overrides || {}).disabledSpecials) || []).map(n => String(n).toLowerCase().trim()));

        // ★ CONFIG-LEVEL facility shut-off (Facilities tab → AVAILABLE/UNAVAILABLE switch =
        //   available:false on the room's backing field entry). The PERMANENT analog of the
        //   per-date Resource disables above. The solver/STEP 7.6 honor it (canBlockFit +
        //   _sportFields76 filter on available!==false), but THIS fill path (STEP 7.5 silent
        //   fallback + the manual ⚡ Auto Fill button) iterates raw config and never checked
        //   it — re-filling sports onto a shut-off field and specials hosted in a shut-off
        //   room. Gate the sport branch by f.available and the special branch by its host.
        const _unavailFieldsLc = new Set((gs.app1?.fields || [])
            .filter(f => f && f.name && f.available === false)
            .map(f => String(f.name).toLowerCase().trim()));

        // Sports / field activities (skipped entirely for a Special-only slot)
        if (_kind !== 'special') (gs.app1?.fields || []).forEach(f => {
            if (!isRainy && (f.rainyOnly || f.rainyDayOnly)) return;
            if (isRainy && (f.dryOnly || f.dryDayOnly)) return;
            // ★ Field shut off in Facilities config (AVAILABLE/UNAVAILABLE switch)
            if (f.available === false) return;
            // ★ Field disabled today in Resources
            if (_disabledLc.has(String(f.name).toLowerCase().trim())) return;
            // ★ Grade restriction — skip if this field excludes our division
            if (isDivisionRestricted(f, divName)) return;
            // ★ Time rules — skip if [slotStart, slotEnd] is unavailable
            if (isFieldBlockedByTimeRules(f.name, slotStart, slotEnd, actProps, divName)) return;
            // ★ GlobalFieldLocks — skip if locked by another league/event
            if (isFieldGloballyLocked(f.name, slotStart, slotEnd, divName)) return;
            // ★ Skeleton field reservations (pinned event / league) — canBlockFit parity
            if (isFieldPinReserved(f.name, slotStart, slotEnd)) return;
            // ★ Cross-bunk capacity (incl. combo partners)
            if (!isFieldAvailable(f.name, bunk, divName, slotStart, slotEnd, actProps)) return;
            // ★ Specific sports disabled on THIS field today (dailyDisabledSportsByField)
            const _blockedOnField = _disabledSportsByField[f.name] || null;
            (f.activities || []).forEach(actName => {
                if (_blockedOnField && _blockedOnField.indexOf(actName) !== -1) return;
                // ★ Per-date bunk-only restriction (sport actName / facility f.name)
                if (window.SchedulerCoreUtils?.isBunkRestrictedFromTarget?.(bunk, actName, f.name, divName)) return;
                // ★ Same-activity-when-sharing: skip a sport whose field is already held
                //   by a DIFFERENT activity at this time (mismatch double-book).
                if (!isFieldAvailable(f.name, bunk, divName, slotStart, slotEnd, actProps, actName)) return;
                candidates.push({ activity: actName, field: f.name, type: 'sport', maxUsage: f.maxUsage || 0, maxUsagePeriod: f.maxUsagePeriod || 'half', exactFrequency: f.exactFrequency || 0, exactFrequencyPeriod: f.exactFrequencyPeriod || '1week' });
            });
        });

        // Special activities (skipped entirely for a Sports-only slot)
        if (_kind !== 'sport') {
            // ★ Valid-location set (facilities ∪ fields). A special whose `location`
            //   isn't a real facility/field (e.g. "Canteen"/"Gameroom" with no such
            //   facility) has nowhere to be held — drop it from fill candidates, matching
            //   the loader + SmartTile gates. Fail-open if the registry is unreadable.
            let _validLocs = null;
            try {
                const _facs = (typeof window.getFacilities === 'function') ? window.getFacilities() : null;
                const _facNames = Array.isArray(_facs) ? _facs.map(f => (f && f.name) || f) : (_facs ? Object.keys(_facs) : []);
                const _fieldNames = (gs.app1?.fields || []).map(f => (f && f.name) || f);
                const _names = _facNames.concat(_fieldNames).filter(Boolean).map(n => String(n).trim().toLowerCase());
                if (_names.length) _validLocs = new Set(_names);
            } catch (_e) {}
            (gs.app1?.specialActivities || []).forEach(s => {
                if (!isRainy && (s.rainyOnly || s.rainyDayOnly)) return;
                if (isRainy && (s.dryOnly || s.dryDayOnly)) return;
                // ★ Special toggled UNAVAILABLE in Facilities (config-level available:false).
                //   The PERMANENT analog of the per-date Resource disable below — the sport
                //   branch above gates on f.available; this is the parity gate for specials.
                if (s.available === false) return;
                // ★ Special disabled today (e.g. its facility was toggled off → cascade)
                if (_disabledSpecialsLc.has(String(s.name).toLowerCase().trim())) return;
                // ★ Access restriction — division AND bunk level. The canonical
                //   check (scheduler_core_auto.js, exposed as window.isSpecialAvailableForBunk)
                //   reads the authoritative special config and honors the per-bunk
                //   allow-list inside accessRestrictions.divisions[grade]. Previously
                //   this only consulted isDivisionRestricted (division/grade level),
                //   so a special restricted to specific bunks within an allowed grade
                //   (e.g. "Sushi" gated to certain bunks) could still be filled into a
                //   General Activity / free slot for a bunk that should never get it.
                if (typeof window.isSpecialAvailableForBunk === 'function') {
                    if (!window.isSpecialAvailableForBunk(s.name, divName, bunk, gs)) return;
                } else if (isDivisionRestricted(s, divName)) {
                    return; // fallback: division-level only when canonical check unavailable
                }
                const loc = s.location || null;
                // ★ Per-date bunk-only restriction (special s.name / facility host).
                //   Resolve host like the shut-off gate below so facility targets match
                //   even when a duplicated special's own .location is blank.
                {
                    const _rHost = loc || (window.getLocationForActivity && window.getLocationForActivity(s.name)) || null;
                    if (window.SchedulerCoreUtils?.isBunkRestrictedFromTarget?.(bunk, s.name, _rHost, divName)) return;
                }
                // ★ Special's host facility shut off in Facilities config. Resolve the host
                //   robustly: this camp duplicates specials cap/lowercase and the dup's own
                //   .location is often blank, so fall back to getLocationForActivity (the same
                //   case-insensitive resolver the lock ledger uses) before checking.
                {
                    const _host = loc || (window.getLocationForActivity && window.getLocationForActivity(s.name)) || '';
                    if (_host && _unavailFieldsLc.has(String(_host).toLowerCase().trim())) return;
                }
                // ★ Special's location/facility disabled today in Resources
                if (loc && _disabledLc.has(String(loc).toLowerCase().trim())) return;
                // ★ Facility-existence gate
                if (_validLocs && loc && String(loc).trim() && !_validLocs.has(String(loc).trim().toLowerCase())) return;
                // ★ Special's OWN config time rules. A HOSTED special (location ≠ name,
                //   e.g. "Cap Making behind Masmidim BM" in room "Cap Making") only had
                //   its ROOM's rules checked below (isFieldBlockedByTimeRules keyed by
                //   loc) — its own Available/Unavailable windows were never consulted on
                //   this leftover-fill path, so the filler could seat it inside its own
                //   closed window (e.g. Unavailable 12:20–1:25). Check the special's own
                //   rules here; fall back to its activityProperties entry (dual-keyed by
                //   name) when the settings row carries none.
                {
                    const _ownTR = (Array.isArray(s.timeRules) && s.timeRules.length)
                        ? s.timeRules
                        : (actProps?.[s.name]?.timeRules || null);
                    if (areTimeRulesBlocking(_ownTR, slotStart, slotEnd, divName)) return;
                }
                if (loc) {
                    if (isFieldBlockedByTimeRules(loc, slotStart, slotEnd, actProps, divName)) return;
                    if (isFieldGloballyLocked(loc, slotStart, slotEnd, divName)) return;
                    // ★ Skeleton field reservations (pinned event / league) — canBlockFit parity
                    if (isFieldPinReserved(loc, slotStart, slotEnd)) return;
                    // ★ wantActivity = s.name: reject this special if its room is already
                    //   held by a DIFFERENT activity (a different special, or a sport that
                    //   shares the room) — a shared room hosts one activity at a time.
                    if (!isFieldAvailable(loc, bunk, divName, slotStart, slotEnd, actProps, s.name)) return;
                }
                candidates.push({ activity: s.name, field: loc, type: 'special', maxUsage: s.maxUsage || 0, maxUsagePeriod: s.maxUsagePeriod || 'half', exactFrequency: s.exactFrequency || 0, exactFrequencyPeriod: s.exactFrequencyPeriod || '1week' });
            });
        }

        return candidates;
    }

    // ========================================================================
    // ROTATION HISTORY — compute from allDaily + rotationHistory
    // ========================================================================

    function buildHistory(bunk, today) {
        const allDaily = window.loadAllDailyData?.() || {};
        const countsByAct = {};
        const lastDoneByAct = {};
        const todayActs = new Set();

        // Live slots for TODAY from window.scheduleAssignments
        (window.scheduleAssignments?.[bunk] || []).forEach(e => {
            if (!e || e.continuation || e._isTransition) return;
            const a = e._activity || e.activity || e.sport || '';
            if (a && a !== 'Free' && !a.toLowerCase().includes('transition')) todayActs.add(a);
        });

        // Historical data (skip today — we use live data above)
        // ★ HR-35: COMPLETE reset — bunks get new campers at the half, so
        //   pre-epoch days are invisible to counts AND lastDone/recency alike.
        const _epoch = _getRotationEpoch();
        Object.keys(allDaily).sort().forEach(dateKey => {
            if (dateKey === today) return;
            if (_epoch && dateKey < _epoch) return; // ★ HR-35
            const sched = allDaily[dateKey]?.scheduleAssignments?.[bunk] || [];
            sched.forEach(e => {
                if (!e || e.continuation || e._isTransition) return;
                const a = e._activity || e.activity || e.sport || '';
                if (!a || a === 'Free' || a.toLowerCase().includes('transition')) return;
                countsByAct[a] = (countsByAct[a] || 0) + 1;
                if (!lastDoneByAct[a] || dateKey > lastDoneByAct[a]) lastDoneByAct[a] = dateKey;
            });
        });

        // Rotation history store (supplements allDaily)
        const rotHist = window.loadRotationHistory?.() || { bunks: {} };
        const bh = rotHist.bunks?.[bunk] || {};
        Object.keys(bh).forEach(act => {
            try {
                const d = new Date(bh[act]).toISOString().split('T')[0];
                if (_epoch && d < _epoch) return; // ★ HR-35: pre-epoch timestamps invisible
                if (!lastDoneByAct[act] || d > lastDoneByAct[act]) lastDoneByAct[act] = d;
            } catch (_) {}
        });

        return { countsByAct, lastDoneByAct, todayActs };
    }

    // ========================================================================
    // SCORE & PICK — lower score = better candidate
    // ========================================================================

    function scoreAndPick(bunk, candidates, today, divName, slotIdx) {
        const { countsByAct, lastDoneByAct, todayActs } = buildHistory(bunk, today);

        const scorePass = () => candidates.map(c => {
            const act = c.activity;

            // ── HARD DISQUALIFIERS ──────────────────────────────────────────
            if (todayActs.has(act)) return null;     // already doing it today
            // ★ Rotation-engine hard gates (fair-share cap, frequencyDays
            //   cooldown, rotation cohort, per-grade caps, availableDays).
            //   This filler's local scorer knows recency and per-period caps but
            //   NOT the engine's hard blocks — observed live 2026-07-09: bunk
            //   לב's leftover Free slot was filled with fair-share-BLOCKED
            //   Basketball. Gate here so the last-resort fill obeys the same
            //   rules as every other placement path. When this strict pass
            //   empties the pool, the relax pass below may re-admit ONLY
            //   fair-share-capped candidates (never yesterday-repeats or real
            //   caps) so the slot fills instead of going Free.
            if (window.RotationEngine?.calculateRotationScore) {
                const rot = window.RotationEngine.calculateRotationScore({
                    bunkName: bunk, activityName: act,
                    divisionName: divName || null,
                    beforeSlotIndex: (typeof slotIdx === 'number' ? slotIdx : 0),
                    allActivities: null,
                    activityProperties: window.activityProperties || {}
                });
                if (rot === Infinity) return null;   // hard-blocked by the engine
            }
            // ★ Back-to-back gate (kill switch: window.__fallbackYesterdayGate = false).
            //   YESTERDAY_PENALTY (50000, "MUST NOT REPEAT") is finite, so the
            //   Infinity gate above lets a did-it-yesterday candidate through when
            //   it's the only legal one left — observed live 2026-07-09: bunk לב's
            //   accessible pool was {Basketball, Hockey, Dodgeball: fair-share
            //   capped; Baseball: done yesterday} and the fill repeated Baseball
            //   two days running. Same policy as the fair-share gate: the
            //   last-resort fill leaves the slot Free rather than hand a bunk the
            //   same activity on consecutive days. Recency >= YESTERDAY_PENALTY
            //   also covers same-day (Infinity) and active streaks.
            if (window.__fallbackYesterdayGate !== false &&
                window.RotationEngine?.calculateRecencyScore) {
                const _yp = window.RotationEngine.CONFIG?.YESTERDAY_PENALTY || 50000;
                const rec = window.RotationEngine.calculateRecencyScore(
                    bunk, act, (typeof slotIdx === 'number' ? slotIdx : 0));
                if (rec >= _yp) return null;         // did it yesterday — stay Free
            }
            // ★ FN-4: maxUsage / exactFrequency are PER-PERIOD caps. Compare them
            //   against a period-windowed count, NOT the lifetime countsByAct — else
            //   the cap silently degrades into a lifetime cap and permanently blocks
            //   the activity later in the season (e.g. "max 2 per week" stops the
            //   activity forever after 2 total occurrences). Mirrors the auto
            //   planner's getPeriodCount usage (scheduler_core_auto.js:4253).
            //   Fallback to the lifetime count if SchedulerCoreUtils is unavailable
            //   (never break); period count <= lifetime, so this only RELAXES the
            //   over-restriction, never adds a false block.
            const _gpc = window.SchedulerCoreUtils && window.SchedulerCoreUtils.getPeriodActivityCount;
            const _maxCount = _gpc ? _gpc(bunk, act, c.maxUsagePeriod || 'half', today) : (countsByAct[act] || 0);
            if (c.maxUsage > 0 && _maxCount >= c.maxUsage) return null; // at per-period limit
            const _exactCount = _gpc ? _gpc(bunk, act, c.exactFrequencyPeriod || '1week', today) : (countsByAct[act] || 0);
            if (c.exactFrequency > 0 && _exactCount >= c.exactFrequency) return null; // at per-period exact limit

            // ── SCORING ─────────────────────────────────────────────────────
            let score = 0;
            const count = countsByAct[act] || 0;   // lifetime count — correct for the fairness tiers below

            if (count === 0) score -= 5000;           // never done — strong bonus
            else if (count === 1) score -= 2000;
            else if (count === 2) score -= 500;

            const last = lastDoneByAct[act];
            if (last) {
                const diff = Math.round((new Date(today) - new Date(last)) / 86_400_000);
                if (diff === 1) score += 9000;        // yesterday — heavy penalty
                else if (diff === 2) score += 5000;
                else if (diff === 3) score += 2500;
                else if (diff >= 7) score -= 2000;    // long time ago — bonus
            }

            // Escalating bonus for exact frequency: pull harder as period deadline nears
            if (c.exactFrequency > 0) {
                const needed = c.exactFrequency - _exactCount;  // ★ FN-4: per-period count, not lifetime
                if (needed > 0) {
                    const esc = window.SchedulerCoreUtils?.getEscalationBonus?.(c.exactFrequencyPeriod || '1week', needed);
                    score -= esc || (needed * 100);
                }
            }

            // ★ Avoid-unless-needed (Rules tab soft rule): keep the candidate but
            //   rank it below every normal one — this last-resort fill only hands
            //   it out when the alternative is leaving the slot Free. Mirrors the
            //   rotation engine's AVOID_UNLESS_NEEDED_PENALTY, scaled to this
            //   scorer's local range (±9000).
            if (window.SchedulerCoreUtils?.isSportAvoidedUnlessNeeded?.(divName, act)) {
                score += 1000000;
            }

            // Small random tie-breaker so repeated calls vary
            score += Math.random() * 50;

            return { ...c, score, count, last };
        }).filter(Boolean);

        let scored = scorePass();

        // ★ LAST-RESORT FAIR-SHARE RELAX (observed live 2026-07-08/09: bunk לב's
        //   entire pool was fair-share-capped + cooldown-blocked, so the gates
        //   above left the slot Free two days running). Policy order is
        //   no-back-to-back > no-Free > fair-share bookkeeping: when the strict
        //   pass yields NOTHING, re-score once with the fair-share cap switched
        //   off. Everything else stays hard — same-day dupes, the yesterday
        //   gate, maxUsage/exactFrequency ceilings, frequencyDays cooldowns,
        //   cohort waits and availableDays all still block (they live outside
        //   the __fairShareHardCap switch), so only "you're ahead of the
        //   laggards" candidates come back. A slot whose sole relaxed candidate
        //   was done yesterday STILL stays Free.
        //   Kill switch: window.__fallbackFairShareRelax = false.
        let relaxed = false;
        if (!scored.length &&
            window.__fallbackFairShareRelax !== false &&
            window.__fairShareHardCap !== false &&
            window.RotationEngine?.calculateRotationScore) {
            const _prevCap = window.__fairShareHardCap;
            window.__fairShareHardCap = false;
            try { scored = scorePass(); } finally { window.__fairShareHardCap = _prevCap; }
            relaxed = scored.length > 0;
        }

        if (!scored.length) return null;
        scored.sort((a, b) => a.score - b.score);
        const best = scored[0];
        if (relaxed) best._fairShareRelaxed = true;
        return best;
    }

    // ========================================================================
    // WRITE THE FILL
    // ========================================================================

    function writeFill(bunk, slotIdx, pick) {
        if (typeof window.applyDirectEdit === 'function') {
            window.applyDirectEdit(bunk, [slotIdx], pick.activity, pick.field || null, false);
        } else {
            if (!window.scheduleAssignments)       window.scheduleAssignments = {};
            if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = [];
            window.scheduleAssignments[bunk][slotIdx] = {
                field: pick.field || pick.activity,
                sport: pick.activity,
                _activity: pick.activity,
                _location: pick.field || null,
                continuation: false,
                _fixed: true,
                _postEdit: true,
                _autoFilled: true,
                _editedAt: Date.now(),
            };
        }
    }

    // ========================================================================
    // MAIN ENTRY POINT
    // ========================================================================

    async function autoFillSlot(bunk, slotIdx) {
        // 1. Resolve division + slot time
        const divName = getDivision(bunk);
        if (!divName) { toast('Cannot find division for ' + bunk, 'error'); return; }

        const slot = getSlotInfo(divName, slotIdx, bunk);
        if (!slot) { toast('No time info for slot ' + slotIdx, 'error'); return; }

        const slotStart = slot.startMin;
        const slotEnd   = slot.endMin;

        // 2. Confirm slot is free and not locked
        const entry = window.scheduleAssignments?.[bunk]?.[slotIdx];
        if (entry && entry._fixed && entry._pinned) {
            toast('This slot is pinned and cannot be auto-filled', 'warning');
            return;
        }
        if (entry && !isFreeEntry(entry) && entry._fixed) {
            toast('This slot is locked — clear it first before auto-filling', 'warning');
            return;
        }

        // 3. Build candidates (honoring the slot's Sports-only / Special-only kind)
        const actProps = getActivityProperties();
        const candidates = buildCandidates(bunk, slotStart, slotEnd, divName, actProps, slotKindOf(slot.event));
        if (!candidates.length) { toast('No available activities found for this slot', 'warning'); return; }

        // 4. Score and pick
        const today = window.currentScheduleDate || new Date().toLocaleDateString('en-CA');
        const best = scoreAndPick(bunk, candidates, today, divName, slotIdx);
        if (!best) { toast('All candidates disqualified by constraints — nothing to fill', 'warning'); return; }

        // 5. Write + save + refresh
        writeFill(bunk, slotIdx, best);

        if (typeof window.bypassSaveAllBunks === 'function') {
            await window.bypassSaveAllBunks([bunk]);
        } else {
            window.saveSchedule?.();
        }

        window.updateTable?.();

        const where = best.field ? ` @ ${best.field}` : '';
        const note = best._fairShareRelaxed ? ' (fair-share relaxed)' : '';
        toast(`✓ Auto-filled: ${best.activity}${where}${note}`, 'success');
    }

    // ========================================================================
    // UI — inject "Auto Fill" buttons into free cells
    // ========================================================================

    function injectButtons() {
        document.querySelectorAll('td[data-bunk][data-slot]').forEach(td => {
            const bunk    = td.dataset.bunk;
            const slotIdx = parseInt(td.dataset.slot, 10);
            if (!bunk || isNaN(slotIdx)) return;

            const entry = window.scheduleAssignments?.[bunk]?.[slotIdx];
            if (!isFreeEntry(entry)) return;

            // ★ Skip elective / swim-elective "choice menu" tiles: they're Free by
            //   design (see isElectiveSlot). Killswitch: window.__autoFillSkipElectives = false
            if (window.__autoFillSkipElectives !== false) {
                const divName = getDivision(bunk);
                const slot = divName ? getSlotInfo(divName, slotIdx, bunk) : null;
                if (isElectiveSlot(slot)) return;
            }

            if (td.querySelector('.afs-btn')) return; // already injected

            const btn = document.createElement('button');
            btn.className = 'afs-btn';
            btn.innerHTML = '⚡ Auto Fill';
            btn.title = 'Auto-fill this slot based on rotation history and field availability';
            btn.style.cssText = [
                'display:block', 'margin:5px auto 0', 'padding:3px 10px',
                'background:#1e40af', 'color:#fff', 'border:none', 'border-radius:999px',
                'font-size:0.68rem', 'font-weight:700', 'cursor:pointer',
                'letter-spacing:0.02em', 'opacity:0.82', 'transition:opacity 0.15s',
                'white-space:nowrap',
            ].join(';');

            btn.onmouseenter = () => { btn.style.opacity = '1'; };
            btn.onmouseleave = () => { btn.style.opacity = '0.82'; };

            btn.addEventListener('click', async e => {
                e.stopPropagation();
                e.preventDefault();
                btn.textContent = '…';
                btn.disabled = true;
                try {
                    await autoFillSlot(bunk, slotIdx);
                } catch (err) {
                    toast('Auto-fill error: ' + err.message, 'error');
                    console.error('[AutoFill]', err);
                }
                // Table re-render removes the button; nothing more needed
            });

            td.appendChild(btn);
        });
    }

    function setupInjection() {
        // Wrap updateTable
        const _origUpdate = window.updateTable;
        window.updateTable = function (...args) {
            const r = _origUpdate?.apply(this, args);
            setTimeout(injectButtons, 80);
            return r;
        };

        // Also wrap renderStaggeredView — daily_adjustments.js calls this directly
        const _origRender = window.renderStaggeredView;
        window.renderStaggeredView = function (...args) {
            const r = _origRender?.apply(this, args);
            setTimeout(injectButtons, 150);
            return r;
        };

        // MutationObserver as belt-and-suspenders
        const target = document.getElementById('scheduleTable') || document.body;
        const obs = new MutationObserver(() => {
            clearTimeout(obs._t);
            obs._t = setTimeout(injectButtons, 150);
        });
        obs.observe(target, { childList: true, subtree: true });

        // Initial injection — delay enough for the table to render
        setTimeout(injectButtons, 800);
    }

    // ========================================================================
    // EXPORTS + INIT
    // ========================================================================

    // ─────────────────────────────────────────────────────────────────────
    // SILENT FILL — write the pick directly to scheduleAssignments without
    // toasts, without per-cell saves, without UI updates. The caller is
    // expected to save once at the end. Returns true if a pick was applied.
    // ─────────────────────────────────────────────────────────────────────
    function autoFillSlotSilent(bunk, slotIdx, forcedKind) {
        const divName = getDivision(bunk);
        if (!divName) return false;
        const slot = getSlotInfo(divName, slotIdx, bunk);
        if (!slot) return false;
        const slotStart = slot.startMin, slotEnd = slot.endMin;

        const entry = window.scheduleAssignments?.[bunk]?.[slotIdx];
        if (entry && entry._fixed && entry._pinned) return false;
        if (entry && !isFreeEntry(entry) && entry._fixed) return false;

        const actProps = getActivityProperties();
        // ★ Prefer the caller's explicit tile-kind (authoritative, from the solver's
        //   _slotKind) over the slot.event guess — divisionTimes' event is not always
        //   the raw "Sports Slot" / "Special Activity" label.
        const _kind = (forcedKind === 'sport' || forcedKind === 'special') ? forcedKind : slotKindOf(slot.event);
        const candidates = buildCandidates(bunk, slotStart, slotEnd, divName, actProps, _kind);
        if (!candidates.length) return false;

        const today = window.currentScheduleDate || new Date().toLocaleDateString('en-CA');
        const best = scoreAndPick(bunk, candidates, today, divName, slotIdx);
        if (!best) return false;

        // Write straight to memory — no save, no toast, no updateTable.
        if (!window.scheduleAssignments) window.scheduleAssignments = {};
        if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = [];
        // ★ Day-19 special features for the leftover-slot auto-fill path too, so a
        //   special filled here honors multiPart part label/location, prep, and
        //   durations best-fit just like the main solver write. Gated/no-op for
        //   ordinary activities.
        const _afFeat = (typeof window.computeManualSpecialFeatures === 'function')
            ? window.computeManualSpecialFeatures(best.activity, slotStart, slotEnd, bunk, actProps) : null;
        const _afEntry = {
            field: best.field || best.activity,
            sport: best.activity,
            _activity: best.activity,
            _location: best.field || null,
            continuation: false,
            _fixed: true,
            _autoFilled: true,
            _editedAt: Date.now(),
            // ★★★ CB-47: stamp the slot time on ORDINARY fills too (was only stamped
            // for duration-best-fit specials). Without it, a reader that lacks
            // division/per-bunk slot context for the index (e.g. camper locator on a
            // freshly cloud-loaded manual day) couldn't resolve the fill's time. The
            // special branch below still refines _endMin for best-fit durations.
            _startMin: slotStart,
            _endMin: slotEnd,
        };
        if (_afFeat) {
            if (_afFeat._partLabel) { _afEntry._partNumber = _afFeat._partNumber; _afEntry._totalParts = _afFeat._totalParts; _afEntry._partLabel = _afFeat._partLabel; }
            if (_afFeat._partLocation) { _afEntry.field = _afFeat._partLocation; _afEntry._location = _afFeat._partLocation; _afEntry._partLocation = _afFeat._partLocation; }
            if (_afFeat._prepDuration) { _afEntry._prepDuration = _afFeat._prepDuration; _afEntry._prepLabel = _afFeat._prepLabel; _afEntry._prepLocation = _afFeat._prepLocation; }
            if (_afFeat._endMin) { _afEntry._startMin = slotStart; _afEntry._endMin = _afFeat._endMin; _afEntry._durationBestFit = _afFeat._durationBestFit; }
        }
        window.scheduleAssignments[bunk][slotIdx] = _afEntry;
        // ★ GenTrace: fallback fills happen AFTER the solver's commits, so
        //   without this record they are invisible in the brain trace — the
        //   final schedule showed activities no decision explained.
        if (window.GenTrace && window.GenTrace.active) {
            const _dec = {
                kind: 'fallback-fill', bunk: bunk, division: divName || undefined,
                window: slotStart + '-' + slotEnd,
                chosen: { name: best.activity, field: best.field || null }
            };
            if (best._fairShareRelaxed) _dec.relaxed = 'fairShare';
            window.GenTrace.decision(_dec);
        }
        return true;
    }

    // _scoreAndPick exposed for headless tests (rotation hard-gate coverage)
    window.AutoFillSlot = { autoFillSlot, autoFillSlotSilent, injectButtons, _scoreAndPick: scoreAndPick };

    // Browser-only UI wiring (headless test loads have no document)
    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', setupInjection);
        } else {
            setupInjection();
        }
    }

})();
