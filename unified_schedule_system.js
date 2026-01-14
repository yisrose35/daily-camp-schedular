// =============================================================================
// unified_schedule_system.js v3.1 — CAMPISTRY UNIFIED SCHEDULE SYSTEM
// =============================================================================
//
// This file REPLACES ALL of the following:
// ❌ scheduler_ui.js
// ❌ render_sync_fix.js  
// ❌ view_schedule_loader_fix.js
// ❌ schedule_version_merger.js
// ❌ schedule_version_ui.js
//
// CRITICAL FIXES:
// ✅ Uses findSlotsForRange() to map skeleton blocks to 30-min slot indices
// ✅ Properly handles variable-length skeleton blocks (60min, 20min, etc.)
// ✅ Proper cloud hydration timing
// ✅ League matchup display from all slots in range
// ✅ Version save/load/merge integrated
// ✅ Toolbar hidden by default
// ✅ RBAC and multi-scheduler support
//
// =============================================================================

(function() {
    'use strict';

    console.log('📅 Unified Schedule System v3.1 loading...');

    // =========================================================================
    // CONFIGURATION
    // =========================================================================
    
    const RENDER_DEBOUNCE_MS = 150;
    let DEBUG = false;
    const HIDE_VERSION_TOOLBAR = true;
    
    let _lastRenderTime = 0;
    let _renderQueued = false;
    let _renderTimeout = null;
    let _initialized = false;
    let _cloudHydrated = false;

    // =========================================================================
    // TIME UTILITIES
    // =========================================================================

    function parseTimeToMinutes(str) {
        if (!str || typeof str !== 'string') return null;
        
        let s = str.trim().toLowerCase();
        let meridiem = null;
        
        if (s.endsWith('am') || s.endsWith('pm')) {
            meridiem = s.endsWith('am') ? 'am' : 'pm';
            s = s.replace(/am|pm/g, '').trim();
        } else {
            const match24 = s.match(/^(\d{1,2}):(\d{2})$/);
            if (match24) {
                const h = parseInt(match24[1], 10);
                const m = parseInt(match24[2], 10);
                return h * 60 + m;
            }
            return null;
        }
        
        const match = s.match(/^(\d{1,2})\s*[:]\s*(\d{2})$/);
        if (!match) return null;
        
        let hours = parseInt(match[1], 10);
        const mins = parseInt(match[2], 10);
        
        if (isNaN(hours) || isNaN(mins) || mins < 0 || mins > 59) return null;
        
        if (hours === 12) hours = (meridiem === 'am' ? 0 : 12);
        else if (meridiem === 'pm') hours += 12;
        
        return hours * 60 + mins;
    }

    function minutesToTimeLabel(mins) {
        if (mins === null || mins === undefined) return '';
        const h24 = Math.floor(mins / 60);
        const m = mins % 60;
        const ap = h24 >= 12 ? 'PM' : 'AM';
        const h12 = h24 % 12 || 12;
        return `${h12}:${String(m).padStart(2, '0')} ${ap}`;
    }

    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // =========================================================================
    // HIDE VERSION TOOLBAR
    // =========================================================================
    
    function hideVersionToolbar() {
        if (!HIDE_VERSION_TOOLBAR) return;
        
        const toolbar = document.getElementById('version-toolbar-container');
        if (toolbar) {
            toolbar.style.display = 'none';
            const parent = toolbar.parentElement;
            if (parent && parent.children.length === 1) {
                parent.style.display = 'none';
            }
            if (DEBUG) console.log('[UnifiedSchedule] Hidden version toolbar');
        }
    }

    // =========================================================================
    // DATA LOADING - CLOUD-AWARE
    // =========================================================================

    function getDateKey() {
        return window.currentScheduleDate || new Date().toISOString().split('T')[0];
    }

    function loadDailyData() {
        try {
            const raw = localStorage.getItem('campDailyData_v1');
            if (raw) return JSON.parse(raw);
        } catch (e) {
            console.error('[UnifiedSchedule] Error loading daily data:', e);
        }
        return {};
    }

    function loadScheduleForDate(dateKey) {
        if (!dateKey) dateKey = getDateKey();
        
        if (DEBUG) console.log(`[UnifiedSchedule] Loading data for: ${dateKey}`);
        
        const dailyData = loadDailyData();
        const dateData = dailyData[dateKey] || {};
        
        // =====================================================================
        // 1. SCHEDULE ASSIGNMENTS - Priority loading
        // =====================================================================
        
        let loadedAssignments = false;
        
        // Priority 1: Window global (set by cloud bridge, version merger, generator)
        if (window.scheduleAssignments && Object.keys(window.scheduleAssignments).length > 0) {
            loadedAssignments = true;
            if (DEBUG) console.log('[UnifiedSchedule] Using window.scheduleAssignments:', Object.keys(window.scheduleAssignments).length);
        }
        // Priority 2: Date-specific localStorage
        else if (dateData.scheduleAssignments && Object.keys(dateData.scheduleAssignments).length > 0) {
            window.scheduleAssignments = dateData.scheduleAssignments;
            loadedAssignments = true;
            if (DEBUG) console.log('[UnifiedSchedule] Loaded from dateData:', Object.keys(window.scheduleAssignments).length);
        }
        // Priority 3: Root-level legacy
        else if (dailyData.scheduleAssignments && Object.keys(dailyData.scheduleAssignments).length > 0) {
            window.scheduleAssignments = dailyData.scheduleAssignments;
            loadedAssignments = true;
            if (DEBUG) console.log('[UnifiedSchedule] Loaded from root:', Object.keys(window.scheduleAssignments).length);
        }
        
        if (!loadedAssignments) {
            window.scheduleAssignments = window.scheduleAssignments || {};
        }
        
        // =====================================================================
        // 2. LEAGUE ASSIGNMENTS
        // =====================================================================
        
        if (!window.leagueAssignments || Object.keys(window.leagueAssignments).length === 0) {
            if (dateData.leagueAssignments && Object.keys(dateData.leagueAssignments).length > 0) {
                window.leagueAssignments = dateData.leagueAssignments;
            } else {
                window.leagueAssignments = {};
            }
        }
        
        // =====================================================================
        // 3. UNIFIED TIMES - Build from skeleton if needed
        // =====================================================================
        
        if (dateData.unifiedTimes && dateData.unifiedTimes.length > 0) {
            window.unifiedTimes = normalizeUnifiedTimes(dateData.unifiedTimes);
        } else if (!window.unifiedTimes || window.unifiedTimes.length === 0) {
            const skeleton = getSkeleton(dateKey);
            if (skeleton.length > 0) {
                window.unifiedTimes = buildUnifiedTimesFromSkeleton(skeleton);
                if (DEBUG) console.log('[UnifiedSchedule] Built unifiedTimes from skeleton:', window.unifiedTimes.length);
            }
        }
        
        // =====================================================================
        // 4. SKELETON
        // =====================================================================
        
        if (dateData.manualSkeleton && dateData.manualSkeleton.length > 0) {
            window.manualSkeleton = dateData.manualSkeleton;
        } else if (dateData.skeleton && dateData.skeleton.length > 0) {
            window.manualSkeleton = dateData.skeleton;
        }
        
        if (DEBUG) {
            console.log('[UnifiedSchedule] Data state:', {
                assignments: Object.keys(window.scheduleAssignments || {}).length,
                leagues: Object.keys(window.leagueAssignments || {}).length,
                times: (window.unifiedTimes || []).length,
                skeleton: (window.manualSkeleton || window.skeleton || []).length
            });
        }
        
        return {
            scheduleAssignments: window.scheduleAssignments || {},
            leagueAssignments: window.leagueAssignments || {},
            unifiedTimes: window.unifiedTimes || [],
            skeleton: window.manualSkeleton || window.skeleton || []
        };
    }

    function getSkeleton(dateKey) {
        const dailyData = loadDailyData();
        const dateData = dailyData[dateKey || getDateKey()] || {};
        return dateData.manualSkeleton || dateData.skeleton || 
               window.manualSkeleton || window.skeleton || [];
    }

    function normalizeUnifiedTimes(times) {
        if (!times || !Array.isArray(times)) return [];
        return times.map(t => ({
            start: t.start instanceof Date ? t.start : new Date(t.start),
            end: t.end instanceof Date ? t.end : new Date(t.end),
            label: t.label || ''
        }));
    }

    /**
     * Build unifiedTimes from skeleton using 30-minute intervals.
     * This matches how scheduler_core_main.js generates the time grid.
     * The scheduler uses INCREMENT_MINS = 30 to create slots.
     */
    function buildUnifiedTimesFromSkeleton(skeleton) {
        const INCREMENT_MINS = 30;
        
        if (!skeleton || skeleton.length === 0) return [];
        
        // Find the earliest start and latest end across ALL divisions
        let minTime = 540; // Default 9 AM
        let maxTime = 960; // Default 4 PM
        let found = false;
        
        skeleton.forEach(block => {
            const startMin = parseTimeToMinutes(block.startTime);
            const endMin = parseTimeToMinutes(block.endTime);
            
            if (startMin !== null) {
                minTime = Math.min(minTime, startMin);
                found = true;
            }
            if (endMin !== null) {
                maxTime = Math.max(maxTime, endMin);
                found = true;
            }
        });
        
        if (!found) return [];
        
        // Round down minTime to nearest 30-min
        minTime = Math.floor(minTime / INCREMENT_MINS) * INCREMENT_MINS;
        
        // Round up maxTime to nearest 30-min
        maxTime = Math.ceil(maxTime / INCREMENT_MINS) * INCREMENT_MINS;
        
        // Generate 30-minute slots from min to max
        const timeSlots = [];
        const baseDate = new Date();
        baseDate.setHours(0, 0, 0, 0);
        
        for (let mins = minTime; mins < maxTime; mins += INCREMENT_MINS) {
            const startDate = new Date(baseDate);
            startDate.setMinutes(mins);
            
            const endDate = new Date(baseDate);
            endDate.setMinutes(mins + INCREMENT_MINS);
            
            timeSlots.push({
                start: startDate,
                end: endDate,
                startMin: mins,
                endMin: mins + INCREMENT_MINS,
                label: `${minutesToTimeLabel(mins)} - ${minutesToTimeLabel(mins + INCREMENT_MINS)}`
            });
        }
        
        if (DEBUG) console.log(`[UnifiedSchedule] Generated ${timeSlots.length} slots (${minutesToTimeLabel(minTime)} - ${minutesToTimeLabel(maxTime)})`);
        
        return timeSlots;
    }

    // =========================================================================
    // SLOT INDEX MAPPING - CRITICAL FOR VARIABLE TIME BLOCKS
    // =========================================================================
    
    /**
     * Get the start time in minutes from a unifiedTimes slot
     */
    function getSlotStartMin(slot) {
        if (!slot) return null;
        if (slot.startMin !== undefined) return slot.startMin;
        if (slot.start instanceof Date) {
            return slot.start.getHours() * 60 + slot.start.getMinutes();
        }
        if (slot.start) {
            const d = new Date(slot.start);
            return d.getHours() * 60 + d.getMinutes();
        }
        return null;
    }

    /**
     * Find ALL slot indices in unifiedTimes that fall within a skeleton block's time range.
     * This is the KEY FIX - skeleton blocks can span multiple 30-min slots.
     * 
     * Example: Skeleton block 11:00 AM - 12:00 PM (60 min) 
     *          unifiedTimes has 30-min slots: [0]=11:00, [1]=11:30, [2]=12:00...
     *          This returns [0, 1] - both slots that fall within the block
     */
    function findSlotsForRange(startMin, endMin, unifiedTimes) {
        if (!unifiedTimes || unifiedTimes.length === 0) return [];
        if (startMin === null || endMin === null) return [];
        
        const slots = [];
        
        unifiedTimes.forEach((t, idx) => {
            const slotStart = getSlotStartMin(t);
            if (slotStart !== null && slotStart >= startMin && slotStart < endMin) {
                slots.push(idx);
            }
        });
        
        return slots;
    }
    
    /**
     * Find the FIRST slot index for a time. Uses findSlotsForRange internally.
     */
    function findSlotIndexForTime(targetMin, unifiedTimes) {
        if (!unifiedTimes || unifiedTimes.length === 0 || targetMin === null) {
            return -1;
        }
        
        // First try exact match
        for (let i = 0; i < unifiedTimes.length; i++) {
            const slotStart = getSlotStartMin(unifiedTimes[i]);
            if (slotStart === targetMin) {
                return i;
            }
        }
        
        // Try finding slots within a 30-min window
        const slots = findSlotsForRange(targetMin, targetMin + 30, unifiedTimes);
        if (slots.length > 0) return slots[0];
        
        // Closest match (fallback)
        let closest = -1;
        let minDiff = Infinity;
        
        for (let i = 0; i < unifiedTimes.length; i++) {
            const slotStart = getSlotStartMin(unifiedTimes[i]);
            if (slotStart !== null) {
                const diff = Math.abs(slotStart - targetMin);
                if (diff < minDiff) {
                    minDiff = diff;
                    closest = i;
                }
            }
        }
        
        return closest;
    }
    
    /**
     * Get entry for a skeleton block - checks ALL slots within the block's time range
     * and returns the first non-empty, non-continuation entry found.
     */
    function getEntryForBlock(bunk, startMin, endMin, unifiedTimes) {
        const slots = findSlotsForRange(startMin, endMin, unifiedTimes);
        const assignments = window.scheduleAssignments || {};
        
        if (!assignments[bunk]) return { entry: null, slotIdx: slots[0] || -1 };
        
        // Find first non-continuation entry in any of these slots
        for (const slotIdx of slots) {
            const entry = assignments[bunk][slotIdx];
            if (entry && !entry.continuation) {
                return { entry, slotIdx };
            }
        }
        
        // If all are continuations, return the first entry
        if (slots.length > 0 && assignments[bunk][slots[0]]) {
            return { entry: assignments[bunk][slots[0]], slotIdx: slots[0] };
        }
        
        return { entry: null, slotIdx: slots[0] || -1 };
    }

    // =========================================================================
    // ENTRY ACCESS & FORMATTING
    // =========================================================================

    function getEntry(bunk, slotIndex) {
        const assignments = window.scheduleAssignments || {};
        if (!assignments[bunk]) return null;
        return assignments[bunk][slotIndex] || null;
    }

    function formatEntry(entry) {
        if (!entry) return '';
        if (entry._isDismissal) return 'Dismissal';
        if (entry._isSnack) return 'Snacks';
        if (entry._isTransition) return '';
        if (entry.continuation) return '';
        
        const activity = entry._activity || '';
        const field = typeof entry.field === 'object' ? entry.field.name : (entry.field || '');
        const sport = entry.sport || '';
        
        if (entry._h2h) {
            return entry._gameLabel || sport || 'League Game';
        }
        
        if (entry._fixed) return activity || field;
        
        if (field && sport && field !== sport) {
            return `${field} – ${sport}`;
        }
        
        return activity || field || '';
    }

    function getEntryBackground(entry, blockEvent) {
        if (!entry) {
            if (blockEvent && isFixedBlockType(blockEvent)) return '#fff8e1';
            return '#f9fafb';
        }
        
        if (entry._isDismissal) return '#ffebee';
        if (entry._isSnack) return '#fff3e0';
        if (entry._isTransition) return '#e8eaf6';
        if (entry._isTrip) return '#e8f5e9';
        if (entry._h2h || entry._isSpecialtyLeague) return '#e3f2fd';
        if (entry._fixed) return '#fff8e1';
        if (entry._fromBackground) return '#f3e5f5';
        
        return '#f0f9ff';
    }

    function isFixedBlockType(eventName) {
        if (!eventName) return false;
        const lower = eventName.toLowerCase();
        return lower.includes('lunch') || lower.includes('snack') || 
               lower.includes('swim') || lower.includes('dismissal') ||
               lower.includes('rest') || lower.includes('free');
    }

    function isLeagueBlockType(eventName) {
        if (!eventName) return false;
        return eventName.toLowerCase().includes('league');
    }

    // =========================================================================
    // LEAGUE MATCHUPS RETRIEVAL
    // =========================================================================

    function getLeagueMatchups(divName, slotIdx) {
        const leagues = window.leagueAssignments || {};
        
        // Priority 1: Direct leagueAssignments lookup
        if (leagues[divName] && leagues[divName][slotIdx]) {
            const data = leagues[divName][slotIdx];
            return {
                matchups: data.matchups || [],
                gameLabel: data.gameLabel || '',
                sport: data.sport || ''
            };
        }
        
        // Priority 2: Scan scheduleAssignments for _allMatchups
        const divisions = window.divisions || {};
        const bunks = divisions[divName]?.bunks || [];
        const assignments = window.scheduleAssignments || {};
        
        for (const bunk of bunks) {
            const entry = assignments[bunk]?.[slotIdx];
            if (entry && entry._allMatchups && entry._allMatchups.length > 0) {
                return {
                    matchups: entry._allMatchups,
                    gameLabel: entry._gameLabel || '',
                    sport: entry.sport || ''
                };
            }
        }
        
        // Priority 3: Check if ANY bunk has _h2h at this slot
        for (const bunk of bunks) {
            const entry = assignments[bunk]?.[slotIdx];
            if (entry && entry._h2h) {
                return {
                    matchups: [],
                    gameLabel: entry._gameLabel || 'Game',
                    sport: entry.sport || ''
                };
            }
        }
        
        return { matchups: [], gameLabel: '', sport: '' };
    }

    // =========================================================================
    // MAIN RENDER FUNCTION
    // =========================================================================

    function renderStaggeredView(container) {
        if (!container) {
            container = document.getElementById('scheduleTable');
            if (!container) return;
        }
        
        const dateKey = getDateKey();
        
        // Load data
        loadScheduleForDate(dateKey);
        
        // Get skeleton - THE SOURCE OF TRUTH FOR ROWS
        const skeleton = getSkeleton(dateKey);
        const unifiedTimes = window.unifiedTimes || [];
        const divisions = window.divisions || {};
        
        // Clear container
        container.innerHTML = '';
        
        if (!skeleton || skeleton.length === 0) {
            container.innerHTML = `
                <div style="padding: 40px; text-align: center; color: #6b7280;">
                    <p style="font-size: 1.1rem; margin-bottom: 10px;">No daily schedule structure found for this date.</p>
                    <p style="font-size: 0.9rem;">Use <strong>"Build Day"</strong> in the Master Schedule Builder to create a schedule structure.</p>
                </div>
            `;
            return;
        }
        
        // Get divisions to show
        let divisionsToShow = Object.keys(divisions);
        if (divisionsToShow.length === 0 && window.availableDivisions) {
            divisionsToShow = window.availableDivisions;
        }
        
        // Sort numerically
        divisionsToShow.sort((a, b) => {
            const numA = parseInt(a);
            const numB = parseInt(b);
            if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
            return String(a).localeCompare(String(b));
        });
        
        if (divisionsToShow.length === 0) {
            container.innerHTML = `
                <div style="padding: 40px; text-align: center; color: #6b7280;">
                    <p>No divisions configured. Go to the <strong>Divisions</strong> tab to create divisions.</p>
                </div>
            `;
            return;
        }
        
        // Create wrapper
        const wrapper = document.createElement('div');
        wrapper.className = 'schedule-view-wrapper';
        wrapper.style.cssText = 'display: flex; flex-direction: column; gap: 24px;';
        
        // Get editable divisions for RBAC
        const editableDivisions = window.AccessControl?.getEditableDivisions?.() || divisionsToShow;
        
        if (DEBUG) {
            console.log('[UnifiedSchedule] Rendering:', {
                divisions: divisionsToShow.length,
                skeletonBlocks: skeleton.length,
                unifiedTimes: unifiedTimes.length,
                assignments: Object.keys(window.scheduleAssignments || {}).length
            });
        }
        
        // Render each division
        divisionsToShow.forEach(divName => {
            const divInfo = divisions[divName];
            if (!divInfo) return;
            
            let bunks = divInfo.bunks || [];
            if (bunks.length === 0) return;
            
            bunks = bunks.slice().sort((a, b) => 
                String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
            );
            
            const isEditable = editableDivisions.includes(divName);
            const table = renderDivisionTable(divName, divInfo, bunks, skeleton, unifiedTimes, isEditable);
            if (table) wrapper.appendChild(table);
        });
        
        container.appendChild(wrapper);
        
        // Apply multi-scheduler blocking if available
        if (window.MultiSchedulerAutonomous?.applyBlockingToGrid) {
            setTimeout(() => window.MultiSchedulerAutonomous.applyBlockingToGrid(), 50);
        }
        
        // Dispatch render complete event
        window.dispatchEvent(new CustomEvent('campistry-schedule-rendered', {
            detail: { dateKey }
        }));
        
        if (DEBUG) console.log('[UnifiedSchedule] Render complete');
    }

    function renderDivisionTable(divName, divInfo, bunks, skeleton, unifiedTimes, isEditable) {
        // Filter skeleton blocks for this division
        const divBlocks = skeleton
            .filter(b => b.division === divName)
            .map(b => ({
                ...b,
                startMin: parseTimeToMinutes(b.startTime),
                endMin: parseTimeToMinutes(b.endTime)
            }))
            .filter(b => b.startMin !== null && b.endMin !== null)
            .sort((a, b) => a.startMin - b.startMin);
        
        if (divBlocks.length === 0) {
            if (DEBUG) console.log(`[UnifiedSchedule] No blocks for division: ${divName}`);
            return null;
        }
        
        const table = document.createElement('table');
        table.className = 'schedule-division-table';
        table.style.cssText = `
            width: 100%;
            border-collapse: collapse;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            border-radius: 8px;
            overflow: hidden;
            background: #fff;
            margin-bottom: 8px;
        `;
        
        const divColor = divInfo.color || '#4b5563';
        
        // ===== HEADER =====
        const thead = document.createElement('thead');
        
        // Division name row
        const tr1 = document.createElement('tr');
        const th = document.createElement('th');
        th.colSpan = 1 + bunks.length;
        th.innerHTML = escapeHtml(divName) + (isEditable ? '' : ' <span style="opacity:0.7">🔒</span>');
        th.style.cssText = `
            background: ${divColor};
            color: #fff;
            padding: 12px 16px;
            font-size: 1.1rem;
            font-weight: 600;
            text-align: left;
        `;
        tr1.appendChild(th);
        thead.appendChild(tr1);
        
        // Bunk header row
        const tr2 = document.createElement('tr');
        tr2.style.background = '#f9fafb';
        
        const thTime = document.createElement('th');
        thTime.textContent = 'Time';
        thTime.style.cssText = 'padding: 10px 12px; font-weight: 600; color: #374151; border-bottom: 2px solid #e5e7eb; min-width: 140px;';
        tr2.appendChild(thTime);
        
        bunks.forEach(bunk => {
            const thB = document.createElement('th');
            thB.textContent = bunk;
            thB.style.cssText = 'padding: 10px 12px; font-weight: 600; color: #374151; border-bottom: 2px solid #e5e7eb; min-width: 100px; text-align: center;';
            tr2.appendChild(thB);
        });
        thead.appendChild(tr2);
        table.appendChild(thead);
        
        // ===== BODY =====
        const tbody = document.createElement('tbody');
        
        // Render each skeleton block as a row
        divBlocks.forEach((block, blockIdx) => {
            const timeLabel = `${minutesToTimeLabel(block.startMin)} - ${minutesToTimeLabel(block.endMin)}`;
            
            const tr = document.createElement('tr');
            tr.style.background = blockIdx % 2 === 0 ? '#fff' : '#fafafa';
            
            // Time cell
            const tdTime = document.createElement('td');
            tdTime.textContent = timeLabel;
            tdTime.style.cssText = 'padding: 10px 12px; font-weight: 500; color: #4b5563; border-right: 1px solid #e5e7eb; white-space: nowrap;';
            tr.appendChild(tdTime);
            
            // League block - merged cell with matchups
            if (isLeagueBlockType(block.event)) {
                const td = renderLeagueCell(block, bunks, divName, unifiedTimes, isEditable);
                tr.appendChild(td);
                tbody.appendChild(tr);
                return;
            }
            
            // Regular cells - one per bunk
            bunks.forEach(bunk => {
                const td = renderBunkCell(block, bunk, divName, unifiedTimes, isEditable);
                tr.appendChild(td);
            });
            
            tbody.appendChild(tr);
        });
        
        table.appendChild(tbody);
        return table;
    }

    function renderLeagueCell(block, bunks, divName, unifiedTimes, isEditable) {
        const td = document.createElement('td');
        td.colSpan = bunks.length;
        td.style.cssText = `
            padding: 12px 16px;
            background: linear-gradient(135deg, #e0f2fe 0%, #bae6fd 100%);
            border-left: 4px solid #0284c7;
            vertical-align: top;
        `;
        
        // Find ALL slot indices for this block's time range
        const slots = findSlotsForRange(block.startMin, block.endMin, unifiedTimes);
        const slotIdx = slots.length > 0 ? slots[0] : -1;
        
        // Try to get league info from all slots in the range
        let leagueInfo = { matchups: [], gameLabel: '', sport: '' };
        for (const idx of slots) {
            const info = getLeagueMatchups(divName, idx);
            if (info.matchups.length > 0 || info.gameLabel) {
                leagueInfo = info;
                break;
            }
        }
        
        let title = leagueInfo.gameLabel || block.event;
        if (leagueInfo.sport && !title.toLowerCase().includes(leagueInfo.sport.toLowerCase())) {
            title += ` - ${leagueInfo.sport}`;
        }
        
        let html = `<div style="font-weight: 600; font-size: 1rem; color: #0369a1; margin-bottom: 8px;">🏆 ${escapeHtml(title)}</div>`;
        
        if (leagueInfo.matchups && leagueInfo.matchups.length > 0) {
            html += '<div style="display: flex; flex-wrap: wrap; gap: 8px;">';
            
            leagueInfo.matchups.forEach(m => {
                let matchText;
                if (typeof m === 'string') {
                    matchText = m;
                } else if (m.display) {
                    matchText = m.display;
                } else if (m.teamA && m.teamB) {
                    matchText = `${m.teamA} vs ${m.teamB}`;
                    if (m.field) matchText += ` @ ${m.field}`;
                    if (m.sport) matchText += ` (${m.sport})`;
                } else {
                    matchText = JSON.stringify(m);
                }
                
                html += `<div style="background: #fff; padding: 6px 12px; border-radius: 6px; font-size: 0.875rem; font-weight: normal; color: #1e3a5f; box-shadow: 0 1px 2px rgba(0,0,0,0.05);">${escapeHtml(matchText)}</div>`;
            });
            
            html += '</div>';
        } else {
            html += '<div style="color: #64748b; font-size: 0.875rem; font-style: italic; font-weight: normal;">No matchups scheduled</div>';
        }
        
        td.innerHTML = html;
        
        if (isEditable && bunks.length > 0) {
            td.style.cursor = 'pointer';
            td.onclick = () => editCell(bunks[0], block.startMin, block.endMin, block.event);
        }
        
        return td;
    }

    function renderBunkCell(block, bunk, divName, unifiedTimes, isEditable) {
        const td = document.createElement('td');
        td.style.cssText = 'padding: 8px 10px; text-align: center; border: 1px solid #e5e7eb;';
        
        // Get entry using the new multi-slot lookup
        const { entry, slotIdx } = getEntryForBlock(bunk, block.startMin, block.endMin, unifiedTimes);
        
        // Check multi-scheduler blocking
        let isBlocked = false;
        let blockedReason = '';
        
        if (window.MultiSchedulerAutonomous?.isBunkSlotBlocked) {
            const blockCheck = window.MultiSchedulerAutonomous.isBunkSlotBlocked(bunk, slotIdx);
            if (blockCheck.blocked) {
                isBlocked = true;
                blockedReason = blockCheck.reason;
            }
        }
        
        // Get display text and background
        let displayText = '';
        let bgColor = '#fff';
        
        if (entry && !entry.continuation) {
            displayText = formatEntry(entry);
            bgColor = getEntryBackground(entry, block.event);
        } else if (!entry) {
            // No data - show skeleton event or empty
            if (isFixedBlockType(block.event)) {
                displayText = block.event;
                bgColor = '#fff8e1';
            } else {
                displayText = '';
                bgColor = '#f9fafb';
            }
        }
        
        td.textContent = displayText;
        td.style.background = bgColor;
        
        // Add data attributes for multi-scheduler
        td.dataset.slot = slotIdx;
        td.dataset.slotIndex = slotIdx;
        td.dataset.bunk = bunk;
        td.dataset.division = divName;
        td.dataset.startMin = block.startMin;
        td.dataset.endMin = block.endMin;
        
        // Handle click
        if (isBlocked) {
            td.style.cursor = 'not-allowed';
            td.onclick = () => {
                if (window.showToast) {
                    window.showToast(`🔒 Cannot edit: ${blockedReason}`, 'error');
                } else {
                    alert(`🔒 Cannot edit: ${blockedReason}`);
                }
            };
        } else if (isEditable) {
            td.style.cursor = 'pointer';
            td.onclick = () => editCell(bunk, block.startMin, block.endMin, displayText);
        } else {
            td.style.cursor = 'default';
        }
        
        return td;
    }

    // =========================================================================
    // EDIT CELL
    // =========================================================================

    function editCell(bunk, startMin, endMin, current) {
        if (!bunk) return;
        
        const unifiedTimes = window.unifiedTimes || [];
        const slotIdx = findSlotIndexForTime(startMin, unifiedTimes);
        
        // Check multi-scheduler blocking
        if (window.MultiSchedulerAutonomous?.isBunkSlotBlocked) {
            const blockCheck = window.MultiSchedulerAutonomous.isBunkSlotBlocked(bunk, slotIdx);
            if (blockCheck.blocked) {
                if (window.showToast) {
                    window.showToast(`🔒 Cannot edit: ${blockCheck.reason}`, 'error');
                } else {
                    alert(`🔒 Cannot edit: ${blockCheck.reason}`);
                }
                return;
            }
        }
        
        // Check RBAC permissions
        if (window.AccessControl && !window.AccessControl.canEditBunk?.(bunk)) {
            alert('You do not have permission to edit this schedule.\n\n(You can only edit your assigned divisions.)');
            return;
        }
        
        const timeLabel = `${minutesToTimeLabel(startMin)} - ${minutesToTimeLabel(endMin)}`;
        const newValue = prompt(
            `Edit activity for ${bunk}\n${timeLabel}\n\nCurrent: ${current || 'Empty'}\n\n(Enter CLEAR or FREE to empty)`,
            current || ''
        );
        
        if (newValue === null) return;
        
        const value = newValue.trim();
        const isClear = value === '' || value.toUpperCase() === 'CLEAR' || value.toUpperCase() === 'FREE';
        
        // Find slots for this time range
        let slots = findSlotsForRange(startMin, endMin, unifiedTimes);
        
        if (!slots || slots.length === 0) {
            // Fallback to single slot
            if (slotIdx >= 0) {
                slots = [slotIdx];
            } else {
                alert('Error: Could not match this time range. Please refresh the page.');
                return;
            }
        }
        
        // Initialize if needed
        if (!window.scheduleAssignments) {
            window.scheduleAssignments = {};
        }
        if (!window.scheduleAssignments[bunk]) {
            window.scheduleAssignments[bunk] = new Array((window.unifiedTimes || []).length);
        }
        
        // Apply edit
        slots.forEach((idx, i) => {
            window.scheduleAssignments[bunk][idx] = {
                field: isClear ? 'Free' : value,
                sport: null,
                continuation: i > 0,
                _fixed: true,
                _activity: isClear ? 'Free' : value
            };
        });
        
        // Save and refresh
        saveSchedule();
        updateTable();
    }

    // =========================================================================
    // SAVE & UPDATE
    // =========================================================================

    function saveSchedule() {
        window.saveCurrentDailyData?.('scheduleAssignments', window.scheduleAssignments);
        window.saveCurrentDailyData?.('leagueAssignments', window.leagueAssignments);
        window.saveCurrentDailyData?.('unifiedTimes', window.unifiedTimes);
    }

    function updateTable() {
        const now = Date.now();
        
        // Throttle renders
        if (now - _lastRenderTime < RENDER_DEBOUNCE_MS) {
            if (!_renderQueued) {
                _renderQueued = true;
                if (_renderTimeout) clearTimeout(_renderTimeout);
                
                _renderTimeout = setTimeout(() => {
                    _renderQueued = false;
                    _lastRenderTime = Date.now();
                    const container = document.getElementById('scheduleTable');
                    if (container) renderStaggeredView(container);
                }, RENDER_DEBOUNCE_MS);
            }
            return;
        }
        
        _lastRenderTime = now;
        const container = document.getElementById('scheduleTable');
        if (container) renderStaggeredView(container);
    }

    // =========================================================================
    // VERSION MANAGEMENT - INTEGRATED
    // =========================================================================
    
    const VersionManager = {
        
        async saveVersion(name) {
            const dateKey = getDateKey();
            if (!dateKey) {
                alert('Please select a date first.');
                return { success: false };
            }
            
            if (!name) {
                name = prompt('Enter a name for this version (e.g., "Draft 1", "Morning Final"):');
                if (!name) return { success: false };
            }
            
            const dailyData = loadDailyData();
            const dateData = dailyData[dateKey] || {};
            
            const payload = {
                scheduleAssignments: window.scheduleAssignments || dateData.scheduleAssignments || {},
                leagueAssignments: window.leagueAssignments || dateData.leagueAssignments || {},
                unifiedTimes: window.unifiedTimes || dateData.unifiedTimes || []
            };
            
            if (Object.keys(payload.scheduleAssignments).length === 0) {
                alert('No schedule data to save.');
                return { success: false };
            }
            
            if (!window.ScheduleVersionsDB) {
                alert('Version database not available. Please refresh the page.');
                return { success: false };
            }
            
            try {
                const versions = await window.ScheduleVersionsDB.listVersions(dateKey);
                const existing = versions.find(v => v.name.toLowerCase() === name.toLowerCase());
                
                if (existing) {
                    if (!confirm(`Version "${existing.name}" already exists. Overwrite it?`)) {
                        return { success: false };
                    }
                    
                    if (window.ScheduleVersionsDB.updateVersion) {
                        const result = await window.ScheduleVersionsDB.updateVersion(existing.id, payload);
                        if (result.success) {
                            alert('✅ Version updated successfully!');
                            return { success: true };
                        } else {
                            alert('❌ Error updating: ' + result.error);
                            return { success: false };
                        }
                    }
                }
                
                const result = await window.ScheduleVersionsDB.createVersion(dateKey, name, payload);
                if (result.success) {
                    alert('✅ Version saved successfully!');
                    return { success: true };
                } else {
                    alert('❌ Error saving: ' + result.error);
                    return { success: false };
                }
                
            } catch (err) {
                console.error('Version save error:', err);
                alert('Error saving version: ' + err.message);
                return { success: false };
            }
        },
        
        async loadVersion() {
            const dateKey = getDateKey();
            if (!dateKey) {
                alert('Please select a date first.');
                return;
            }
            
            if (!window.ScheduleVersionsDB) {
                alert('Version database not available.');
                return;
            }
            
            try {
                const versions = await window.ScheduleVersionsDB.listVersions(dateKey);
                
                if (!versions || versions.length === 0) {
                    alert('No saved versions found for this date.');
                    return;
                }
                
                let msg = 'Select a version to load:\n\n';
                versions.forEach((v, i) => {
                    const time = new Date(v.created_at).toLocaleTimeString();
                    msg += `${i + 1}. ${v.name} (${time})\n`;
                });
                
                const choice = prompt(msg);
                if (!choice) return;
                
                const index = parseInt(choice) - 1;
                if (isNaN(index) || !versions[index]) {
                    alert('Invalid selection');
                    return;
                }
                
                const selected = versions[index];
                if (!confirm(`Load "${selected.name}"? This will overwrite the current view.`)) {
                    return;
                }
                
                let data = selected.schedule_data;
                if (typeof data === 'string') {
                    try { data = JSON.parse(data); } catch(e) {}
                }
                
                const assignments = data.scheduleAssignments || data;
                
                window.scheduleAssignments = assignments;
                
                if (data.leagueAssignments) {
                    window.leagueAssignments = data.leagueAssignments;
                }
                
                if (data.unifiedTimes) {
                    window.unifiedTimes = normalizeUnifiedTimes(data.unifiedTimes);
                }
                
                saveSchedule();
                updateTable();
                
                alert('✅ Version loaded!');
                
            } catch (err) {
                console.error('Version load error:', err);
                alert('Error loading version: ' + err.message);
            }
        },
        
        async mergeVersions() {
            const dateKey = getDateKey();
            if (!dateKey) {
                alert('Please select a date first.');
                return { success: false };
            }
            
            if (!window.ScheduleVersionsDB) {
                alert('Version database not available.');
                return { success: false };
            }
            
            if (!confirm(`Merge ALL versions for ${dateKey}?`)) {
                return { success: false };
            }
            
            try {
                const versions = await window.ScheduleVersionsDB.listVersions(dateKey);
                
                if (!versions || versions.length === 0) {
                    alert('No versions to merge.');
                    return { success: false };
                }
                
                if (DEBUG) console.log(`[VersionMerger] Merging ${versions.length} versions...`);
                
                const mergedAssignments = {};
                const bunksTouched = new Set();
                let latestLeagueData = null;
                
                versions.forEach(ver => {
                    let scheduleData = ver.schedule_data || ver.data || ver.payload;
                    
                    if (typeof scheduleData === 'string') {
                        try { scheduleData = JSON.parse(scheduleData); } catch(e) {}
                    }
                    
                    if (!scheduleData) return;
                    
                    const assignments = scheduleData.scheduleAssignments || scheduleData;
                    
                    if (assignments && typeof assignments === 'object') {
                        Object.entries(assignments).forEach(([bunkId, slots]) => {
                            mergedAssignments[bunkId] = slots;
                            bunksTouched.add(bunkId);
                        });
                    }
                    
                    if (scheduleData.leagueAssignments) {
                        latestLeagueData = scheduleData.leagueAssignments;
                    }
                });
                
                if (DEBUG) console.log(`[VersionMerger] Merged ${bunksTouched.size} bunks from ${versions.length} versions`);
                
                window.scheduleAssignments = mergedAssignments;
                
                if (latestLeagueData) {
                    window.leagueAssignments = latestLeagueData;
                }
                
                saveSchedule();
                updateTable();
                
                alert(`✅ Merged ${versions.length} versions (${bunksTouched.size} bunks).`);
                
                return { success: true, count: versions.length, bunks: bunksTouched.size };
                
            } catch (err) {
                console.error('Version merge error:', err);
                alert('Error merging versions: ' + err.message);
                return { success: false };
            }
        }
    };

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    function initScheduleSystem() {
        if (_initialized) return;
        
        const dateKey = getDateKey();
        loadScheduleForDate(dateKey);
        
        _initialized = true;
        if (DEBUG) console.log('[UnifiedSchedule] System initialized');
    }

    function reconcileOrRenderSaved() {
        const dateKey = getDateKey();
        loadScheduleForDate(dateKey);
        updateTable();
    }

    // =========================================================================
    // EVENT LISTENERS
    // =========================================================================

    // Listen for cloud hydration
    window.addEventListener('campistry-cloud-hydrated', () => {
        if (DEBUG) console.log('[UnifiedSchedule] Cloud hydration event received');
        _cloudHydrated = true;
        
        setTimeout(() => {
            loadScheduleForDate(getDateKey());
            updateTable();
        }, 100);
    });

    // Listen for data updates
    window.addEventListener('campistry-daily-data-updated', () => {
        if (DEBUG) console.log('[UnifiedSchedule] Data update event received');
        loadScheduleForDate(getDateKey());
        updateTable();
    });

    // Listen for date changes
    window.addEventListener('campistry-date-changed', (e) => {
        if (DEBUG) console.log('[UnifiedSchedule] Date changed:', e.detail?.dateKey);
        loadScheduleForDate(e.detail?.dateKey || getDateKey());
        updateTable();
    });

    // Hide toolbar when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', hideVersionToolbar);
    } else {
        hideVersionToolbar();
    }

    // Also try after delays (for dynamically added toolbar)
    setTimeout(hideVersionToolbar, 500);
    setTimeout(hideVersionToolbar, 1500);
    setTimeout(hideVersionToolbar, 3000);

    // =========================================================================
    // EXPORTS
    // =========================================================================

    // Core functions
    window.updateTable = updateTable;
    window.renderStaggeredView = renderStaggeredView;
    window.initScheduleSystem = initScheduleSystem;
    window.saveSchedule = saveSchedule;
    window.loadScheduleForDate = loadScheduleForDate;
    window.reconcileOrRenderSaved = reconcileOrRenderSaved;
    
    // Edit functions
    window.editCell = editCell;
    window.findFirstSlotForTime = (min) => findSlotIndexForTime(min, window.unifiedTimes);
    window.findSlotsForRange = (start, end) => findSlotsForRange(start, end, window.unifiedTimes);
    
    // Time utilities
    window.parseTimeToMinutes = parseTimeToMinutes;
    window.minutesToTimeLabel = minutesToTimeLabel;
    
    // Entry functions
    window.getEntry = getEntry;
    window.formatEntry = formatEntry;
    
    // Version management
    window.ScheduleVersionManager = VersionManager;
    
    // Legacy compatibility - ScheduleVersionMerger (used by other modules)
    window.ScheduleVersionMerger = {
        mergeAndPush: async (dateKey) => {
            window.currentScheduleDate = dateKey;
            return await VersionManager.mergeVersions();
        }
    };
    
    // Debug namespace
    window.UnifiedScheduleSystem = {
        version: '3.1',
        loadScheduleForDate,
        renderStaggeredView,
        findSlotIndexForTime,
        findSlotsForRange,
        getLeagueMatchups,
        getEntryForBlock,
        buildUnifiedTimesFromSkeleton,
        VersionManager,
        DEBUG_ON: () => { DEBUG = true; console.log('[UnifiedSchedule] Debug enabled'); },
        DEBUG_OFF: () => { DEBUG = false; console.log('[UnifiedSchedule] Debug disabled'); },
        dumpBunkData: (bunk) => {
            const assignments = window.scheduleAssignments || {};
            const data = assignments[bunk];
            if (!data) {
                console.log(`No data for bunk: ${bunk}`);
                return;
            }
            console.log(`Bunk ${bunk}:`, data.length, 'slots');
            data.forEach((e, i) => {
                if (e && !e.continuation) {
                    const startMin = window.unifiedTimes?.[i]?.startMin || (window.unifiedTimes?.[i]?.start ? 
                        new Date(window.unifiedTimes[i].start).getHours() * 60 + new Date(window.unifiedTimes[i].start).getMinutes() : '?');
                    console.log(`  [${i}] ${minutesToTimeLabel(startMin)}: ${formatEntry(e)}`);
                }
            });
        },
        dumpSlotMapping: (divName) => {
            const skeleton = getSkeleton();
            const divBlocks = skeleton.filter(b => b.division === divName);
            const ut = window.unifiedTimes || [];
            
            console.log(`Slot mapping for Division ${divName}:`);
            console.log(`  unifiedTimes has ${ut.length} slots`);
            
            divBlocks.forEach(block => {
                const startMin = parseTimeToMinutes(block.startTime);
                const endMin = parseTimeToMinutes(block.endTime);
                const slots = findSlotsForRange(startMin, endMin, ut);
                console.log(`  ${block.event}: ${block.startTime}-${block.endTime} → slots [${slots.join(',')}]`);
            });
        },
        getState: () => ({
            dateKey: getDateKey(),
            assignments: Object.keys(window.scheduleAssignments || {}).length,
            leagues: Object.keys(window.leagueAssignments || {}).length,
            times: (window.unifiedTimes || []).length,
            skeleton: (window.manualSkeleton || window.skeleton || []).length,
            cloudHydrated: _cloudHydrated,
            initialized: _initialized
        })
    };

    console.log('📅 Unified Schedule System v3.1 loaded successfully');
    console.log('   Replaces: scheduler_ui.js, render_sync_fix.js, view_schedule_loader_fix.js');
    console.log('   Replaces: schedule_version_merger.js, schedule_version_ui.js');
    console.log('   FIX: Uses findSlotsForRange for variable-length skeleton blocks');

})();
