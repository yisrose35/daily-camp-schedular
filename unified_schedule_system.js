// =============================================================================
// unified_schedule_system.js v1.0 — CAMPISTRY UNIFIED SCHEDULE SYSTEM
// =============================================================================
//
// This file REPLACES the following three files:
// ❌ scheduler_ui.js
// ❌ render_sync_fix.js  
// ❌ view_schedule_loader_fix.js
//
// WHAT THIS FILE DOES:
// ✅ Loads schedule data from localStorage/cloud with proper priority
// ✅ Renders daily schedule view with proper slot alignment
// ✅ Handles league assignments and matchup display
// ✅ Supports multi-scheduler blocking and RBAC
// ✅ Provides edit functionality for schedule cells
// ✅ Prevents render storms with debouncing
// ✅ Fixes wipe protection race conditions
//
// =============================================================================

(function() {
    'use strict';

    console.log('📅 Unified Schedule System v1.0 loading...');

    // =========================================================================
    // CONFIGURATION
    // =========================================================================
    
    const INCREMENT_MINS = 30;
    const RENDER_DEBOUNCE_MS = 100;
    const DEBUG = false;
    
    // Render throttling state
    let _lastRenderTime = 0;
    let _renderQueued = false;
    let _renderTimeout = null;
    let _initialized = false;

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

    // =========================================================================
    // DATA LOADING - SINGLE SOURCE OF TRUTH
    // =========================================================================

    function loadScheduleForDate(dateKey) {
        if (!dateKey) {
            dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        }
        
        if (DEBUG) console.log(`[UnifiedSchedule] Loading schedule for date: ${dateKey}`);
        
        let dailyData = {};
        try {
            const raw = localStorage.getItem('campDailyData_v1');
            if (raw) dailyData = JSON.parse(raw);
        } catch (e) {
            console.error('[UnifiedSchedule] Error loading daily data:', e);
        }

        const dateData = dailyData[dateKey] || {};
        
        // =====================================================================
        // 1. SCHEDULE ASSIGNMENTS - Priority Loading with Wipe Protection
        // =====================================================================
        
        let newAssignments = {};
        
        // Priority 1: Date-specific data
        if (dateData.scheduleAssignments && Object.keys(dateData.scheduleAssignments).length > 0) {
            newAssignments = dateData.scheduleAssignments;
            if (DEBUG) console.log('[UnifiedSchedule] Loaded from date-specific:', Object.keys(newAssignments).length);
        }
        // Priority 2: Root-level legacy data
        else if (dailyData.scheduleAssignments && Object.keys(dailyData.scheduleAssignments).length > 0) {
            newAssignments = dailyData.scheduleAssignments;
            if (DEBUG) console.log('[UnifiedSchedule] Loaded from root-level:', Object.keys(newAssignments).length);
            
            // Migrate to date-specific
            migrateRootLevelData(dailyData, dateKey);
        }
        
        // WIPE PROTECTION: Don't overwrite good data with empty
        const currentCount = Object.keys(window.scheduleAssignments || {}).length;
        const newCount = Object.keys(newAssignments).length;
        
        if (newCount === 0 && currentCount > 0) {
            if (DEBUG) console.log(`[UnifiedSchedule] 🛡️ WIPE PROTECTION: Keeping ${currentCount} bunks`);
            // Keep existing data, don't overwrite
        } else {
            window.scheduleAssignments = newAssignments;
            if (DEBUG) console.log(`[UnifiedSchedule] ✅ Loaded ${newCount} bunks`);
        }
        
        // =====================================================================
        // 2. INJECT SUBDIVISION DRAFTS
        // =====================================================================
        
        if (dateData.subdivisionSchedules) {
            let injected = 0;
            if (!window.scheduleAssignments) window.scheduleAssignments = {};
            
            Object.values(dateData.subdivisionSchedules).forEach(sub => {
                if (sub.scheduleData) {
                    Object.entries(sub.scheduleData).forEach(([bunk, slots]) => {
                        if (!window.scheduleAssignments[bunk] || 
                            !hasValidData(window.scheduleAssignments[bunk])) {
                            window.scheduleAssignments[bunk] = slots;
                            injected++;
                        }
                    });
                }
            });
            if (injected > 0 && DEBUG) {
                console.log(`[UnifiedSchedule] Injected ${injected} bunks from drafts`);
            }
        }
        
        // =====================================================================
        // 3. LEAGUE ASSIGNMENTS
        // =====================================================================
        
        if (dateData.leagueAssignments && Object.keys(dateData.leagueAssignments).length > 0) {
            window.leagueAssignments = dateData.leagueAssignments;
        } else if (!window.leagueAssignments) {
            window.leagueAssignments = {};
        }
        
        // =====================================================================
        // 4. UNIFIED TIMES - With Regeneration Fallback
        // =====================================================================
        
        if (dateData.unifiedTimes && dateData.unifiedTimes.length > 0) {
            window.unifiedTimes = normalizeUnifiedTimes(dateData.unifiedTimes);
            if (DEBUG) console.log(`[UnifiedSchedule] ✅ Loaded ${window.unifiedTimes.length} time slots`);
        }
        else if (window.unifiedTimes && window.unifiedTimes.length > 0) {
            // Preserve existing
            if (DEBUG) console.log('[UnifiedSchedule] 🛡️ Preserving existing unifiedTimes');
        }
        else {
            // Regenerate from skeleton
            const skeleton = dateData.manualSkeleton || dateData.skeleton || 
                            window.manualSkeleton || window.skeleton;
            if (skeleton && skeleton.length > 0) {
                window.unifiedTimes = regenerateTimesFromSkeleton(skeleton);
                if (DEBUG) console.log(`[UnifiedSchedule] ⚠️ Regenerated ${window.unifiedTimes.length} time slots from skeleton`);
            } else {
                window.unifiedTimes = [];
            }
        }
        
        // =====================================================================
        // 5. SKELETON
        // =====================================================================
        
        if (dateData.manualSkeleton && dateData.manualSkeleton.length > 0) {
            window.manualSkeleton = dateData.manualSkeleton;
        } else if (dateData.skeleton && dateData.skeleton.length > 0) {
            window.manualSkeleton = dateData.skeleton;
        }
        // Don't clear existing skeleton if date-specific is empty
        
        return {
            scheduleAssignments: window.scheduleAssignments,
            leagueAssignments: window.leagueAssignments,
            unifiedTimes: window.unifiedTimes,
            skeleton: window.manualSkeleton || window.skeleton || []
        };
    }

    function hasValidData(slots) {
        if (!Array.isArray(slots)) return false;
        return slots.some(s => s && (s.field || s._activity));
    }

    function normalizeUnifiedTimes(times) {
        if (!times || !Array.isArray(times)) return [];
        return times.map(t => ({
            start: t.start instanceof Date ? t.start : new Date(t.start),
            end: t.end instanceof Date ? t.end : new Date(t.end),
            label: t.label || ''
        }));
    }

    function regenerateTimesFromSkeleton(skeleton) {
        if (!skeleton || !Array.isArray(skeleton) || skeleton.length === 0) {
            return [];
        }

        let minTime = 540; // 9:00 AM default
        let maxTime = 960; // 4:00 PM default

        skeleton.forEach(block => {
            const start = parseTimeToMinutes(block.startTime);
            const end = parseTimeToMinutes(block.endTime);
            if (start !== null) minTime = Math.min(minTime, start);
            if (end !== null) maxTime = Math.max(maxTime, end);
        });

        const slots = [];
        const baseDate = new Date();
        baseDate.setHours(0, 0, 0, 0);

        for (let m = minTime; m < maxTime; m += INCREMENT_MINS) {
            const startDate = new Date(baseDate);
            startDate.setMinutes(m);
            const endDate = new Date(baseDate);
            endDate.setMinutes(m + INCREMENT_MINS);

            slots.push({
                start: startDate,
                end: endDate,
                label: `${minutesToTimeLabel(m)} - ${minutesToTimeLabel(m + INCREMENT_MINS)}`
            });
        }

        return slots;
    }

    function migrateRootLevelData(dailyData, dateKey) {
        // Migrate legacy root-level data to date-specific
        const keysToMigrate = ['scheduleAssignments', 'leagueAssignments', 'unifiedTimes', 'manualSkeleton', 'skeleton'];
        
        if (!dailyData[dateKey]) dailyData[dateKey] = {};
        
        keysToMigrate.forEach(key => {
            if (dailyData[key] && !dailyData[dateKey][key]) {
                dailyData[dateKey][key] = dailyData[key];
                delete dailyData[key];
                if (DEBUG) console.log(`[UnifiedSchedule] 📦 Migrated ${key} to date ${dateKey}`);
            }
        });
        
        try {
            localStorage.setItem('campDailyData_v1', JSON.stringify(dailyData));
        } catch (e) {
            console.error('[UnifiedSchedule] Migration save failed:', e);
        }
    }

    // =========================================================================
    // SLOT INDEX CALCULATION - FIXED ALIGNMENT
    // =========================================================================

    function findFirstSlotForTime(startMin) {
        const times = window.unifiedTimes || [];
        if (!times || times.length === 0 || startMin === null) return -1;
        
        for (let i = 0; i < times.length; i++) {
            const t = times[i];
            let slotStart;
            
            if (t.start instanceof Date) {
                slotStart = t.start.getHours() * 60 + t.start.getMinutes();
            } else if (t.start) {
                const d = new Date(t.start);
                slotStart = d.getHours() * 60 + d.getMinutes();
            } else continue;
            
            // Match within INCREMENT_MINS window
            if (slotStart <= startMin && startMin < slotStart + INCREMENT_MINS) {
                return i;
            }
        }
        
        // Fallback: find closest slot
        let closest = -1;
        let minDiff = Infinity;
        
        for (let i = 0; i < times.length; i++) {
            const t = times[i];
            let slotStart;
            
            if (t.start instanceof Date) {
                slotStart = t.start.getHours() * 60 + t.start.getMinutes();
            } else if (t.start) {
                slotStart = new Date(t.start).getHours() * 60 + new Date(t.start).getMinutes();
            } else continue;
            
            const diff = Math.abs(slotStart - startMin);
            if (diff < minDiff) {
                minDiff = diff;
                closest = i;
            }
        }
        
        return closest;
    }

    function findSlotsForRange(startMin, endMin) {
        const times = window.unifiedTimes || [];
        if (!times || times.length === 0) return [];
        if (startMin === null || endMin === null) return [];
        
        const slots = [];
        
        for (let i = 0; i < times.length; i++) {
            const t = times[i];
            let slotStart;
            
            if (t.start instanceof Date) {
                slotStart = t.start.getHours() * 60 + t.start.getMinutes();
            } else if (t.start) {
                slotStart = new Date(t.start).getHours() * 60 + new Date(t.start).getMinutes();
            } else continue;
            
            if (slotStart >= startMin && slotStart < endMin) {
                slots.push(i);
            }
        }
        
        return slots;
    }

    // =========================================================================
    // ENTRY ACCESS & FORMATTING
    // =========================================================================

    function getEntry(bunk, slotIndex) {
        const assignments = window.scheduleAssignments || {};
        if (!assignments[bunk]) return null;
        return assignments[bunk][slotIndex] || null;
    }

    function getLeagueData(division, slotIndex) {
        const leagues = window.leagueAssignments || {};
        if (!leagues[division]) return null;
        return leagues[division][slotIndex] || null;
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
        
        // League game
        if (entry._h2h) {
            return entry._gameLabel || sport || 'League Game';
        }
        
        // Fixed activity
        if (entry._fixed) return activity || field;
        
        // Regular activity with field
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

    function isGeneratedBlockType(eventName) {
        if (!eventName) return false;
        const lower = eventName.toLowerCase();
        return lower.includes('activity') || lower.includes('sport') || 
               lower.includes('special') || eventName.includes('/');
    }

    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // =========================================================================
    // LEAGUE MATCHUPS RETRIEVAL
    // =========================================================================

    function getLeagueMatchups(divName, slotIdx) {
        // Priority 1: leagueAssignments
        const leagueData = getLeagueData(divName, slotIdx);
        if (leagueData && leagueData.matchups) {
            return {
                matchups: leagueData.matchups,
                gameLabel: leagueData.gameLabel || '',
                sport: leagueData.sport || ''
            };
        }
        
        // Priority 2: Scan scheduleAssignments for _allMatchups
        const divisions = window.divisions || {};
        const bunks = divisions[divName]?.bunks || [];
        
        for (const bunk of bunks) {
            const entry = getEntry(bunk, slotIdx);
            if (entry && entry._allMatchups && entry._allMatchups.length > 0) {
                return {
                    matchups: entry._allMatchups,
                    gameLabel: entry._gameLabel || '',
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
        
        container.innerHTML = '';
        
        const role = window.AccessControl?.getCurrentRole?.();
        if (DEBUG) console.log(`📅 [UnifiedSchedule] Rendering for role: ${role}`);
        
        // Get divisions
        const divisions = window.divisions || {};
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
        
        // Load daily data
        const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        let dailyData = {};
        try {
            const raw = localStorage.getItem('campDailyData_v1');
            if (raw) dailyData = JSON.parse(raw);
        } catch (e) {}
        
        const dateData = dailyData[dateKey] || dailyData;
        const skeleton = dateData.manualSkeleton || window.manualSkeleton || window.skeleton || [];
        
        if (!skeleton || skeleton.length === 0) {
            container.innerHTML = `
                <div style="padding: 40px; text-align: center; color: #6b7280;">
                    <p style="font-size: 1.1rem; margin-bottom: 10px;">No daily schedule structure found for this date.</p>
                    <p style="font-size: 0.9rem;">Use <strong>"Build Day"</strong> in the Master Schedule Builder to create a schedule structure.</p>
                </div>
            `;
            return;
        }
        
        if (divisionsToShow.length === 0) {
            container.innerHTML = `
                <div style="padding: 40px; text-align: center; color: #6b7280;">
                    <p>No divisions configured. Go to the <strong>Divisions</strong> tab to create divisions and add bunks.</p>
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
        
        // Render each division
        divisionsToShow.forEach(divName => {
            const divInfo = divisions[divName];
            if (!divInfo) return;
            
            let bunks = divInfo.bunks || [];
            
            // Fallback: find bunks from assignments
            if (bunks.length === 0 && window.scheduleAssignments) {
                const allBunks = Object.keys(window.scheduleAssignments);
                const bunkMeta = window.bunkMetaData || {};
                bunks = allBunks.filter(b => bunkMeta[b]?.division === divName);
            }
            
            bunks = bunks.slice().sort((a, b) => 
                String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
            );
            
            if (bunks.length === 0) {
                if (DEBUG) console.log(`📅 [UnifiedSchedule] Skipping ${divName} - no bunks`);
                return;
            }
            
            if (DEBUG) console.log(`📅 [UnifiedSchedule] Rendering ${divName} with ${bunks.length} bunks`);
            
            const isEditable = editableDivisions.includes(divName);
            const table = renderDivisionTable(divName, divInfo, bunks, skeleton, isEditable);
            wrapper.appendChild(table);
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
    }

    function renderDivisionTable(divName, divInfo, bunks, skeleton, isEditable) {
        const table = document.createElement('table');
        table.className = 'schedule-division-table';
        table.style.cssText = `
            width: 100%;
            border-collapse: collapse;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            border-radius: 8px;
            overflow: hidden;
            background: #fff;
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
        thTime.style.cssText = 'padding: 10px 12px; font-weight: 600; color: #374151; border-bottom: 2px solid #e5e7eb; min-width: 120px;';
        tr2.appendChild(thTime);
        
        bunks.forEach(bunk => {
            const thB = document.createElement('th');
            thB.textContent = bunk;
            thB.style.cssText = 'padding: 10px 12px; font-weight: 600; color: #374151; border-bottom: 2px solid #e5e7eb; min-width: 100px;';
            tr2.appendChild(thB);
        });
        thead.appendChild(tr2);
        table.appendChild(thead);
        
        // ===== BODY =====
        const tbody = document.createElement('tbody');
        
        // Process skeleton blocks for this division
        const blocks = skeleton
            .filter(b => b.division === divName)
            .map(b => ({
                ...b,
                startMin: parseTimeToMinutes(b.startTime),
                endMin: parseTimeToMinutes(b.endTime)
            }))
            .filter(b => b.startMin !== null && b.endMin !== null)
            .sort((a, b) => a.startMin - b.startMin);
        
        // Expand split blocks
        const expandedBlocks = [];
        blocks.forEach(block => {
            if (block.type === 'split') {
                const mid = block.startMin + Math.floor((block.endMin - block.startMin) / 2);
                expandedBlocks.push({
                    ...block,
                    endMin: mid,
                    label: `${minutesToTimeLabel(block.startMin)} - ${minutesToTimeLabel(mid)}`
                });
                expandedBlocks.push({
                    ...block,
                    startMin: mid,
                    label: `${minutesToTimeLabel(mid)} - ${minutesToTimeLabel(block.endMin)}`
                });
            } else {
                expandedBlocks.push({
                    ...block,
                    label: `${minutesToTimeLabel(block.startMin)} - ${minutesToTimeLabel(block.endMin)}`
                });
            }
        });
        
        // Render each row
        expandedBlocks.forEach((block, idx) => {
            const tr = document.createElement('tr');
            tr.style.background = idx % 2 === 0 ? '#fff' : '#fafafa';
            
            // Time cell
            const tdTime = document.createElement('td');
            tdTime.textContent = block.label;
            tdTime.style.cssText = 'padding: 10px 12px; font-weight: 500; color: #4b5563; border-right: 1px solid #e5e7eb; white-space: nowrap;';
            tr.appendChild(tdTime);
            
            // League block - merged cell with matchups
            if (isLeagueBlockType(block.event)) {
                const td = renderLeagueCell(block, bunks, divName, isEditable);
                tr.appendChild(td);
                tbody.appendChild(tr);
                return;
            }
            
            // Regular cells
            if (bunks.length === 0) {
                const td = document.createElement('td');
                td.colSpan = 1;
                td.textContent = 'No bunks configured';
                td.style.cssText = 'padding: 10px; color: #999; font-style: italic;';
                tr.appendChild(td);
            } else {
                bunks.forEach(bunk => {
                    const td = renderBunkCell(block, bunk, divName, isEditable);
                    tr.appendChild(td);
                });
            }
            
            tbody.appendChild(tr);
        });
        
        table.appendChild(tbody);
        return table;
    }

    function renderLeagueCell(block, bunks, divName, isEditable) {
        const td = document.createElement('td');
        td.colSpan = bunks.length;
        td.style.cssText = `
            padding: 12px 16px;
            background: linear-gradient(135deg, #e0f2fe 0%, #bae6fd 100%);
            border-left: 4px solid #0284c7;
            vertical-align: top;
            font-weight: bold;
        `;
        
        const slotIdx = findFirstSlotForTime(block.startMin);
        const leagueInfo = getLeagueMatchups(divName, slotIdx);
        
        let title = leagueInfo.gameLabel || block.event;
        if (leagueInfo.sport && !title.includes(leagueInfo.sport)) {
            title += ` - ${leagueInfo.sport}`;
        }
        
        let html = `<div style="font-size: 1rem; color: #0369a1; margin-bottom: 8px;">🏆 ${escapeHtml(title)}</div>`;
        
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

    function renderBunkCell(block, bunk, divName, isEditable) {
        const td = document.createElement('td');
        td.style.cssText = 'padding: 8px 10px; text-align: center; border: 1px solid #e5e7eb;';
        
        const slotIdx = findFirstSlotForTime(block.startMin);
        const entry = getEntry(bunk, slotIdx);
        
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
            if (isFixedBlockType(block.event)) {
                displayText = block.event;
                bgColor = '#fff8e1';
            } else if (isGeneratedBlockType(block.event)) {
                displayText = '';
                bgColor = '#f9fafb';
            } else {
                displayText = block.event;
                bgColor = '#fff7ed';
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
        
        const slotIdx = findFirstSlotForTime(startMin);
        
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
        const slots = findSlotsForRange(startMin, endMin);
        
        if (!slots || slots.length === 0) {
            alert('Error: Could not match this time range to the schedule grid. Please refresh the page.');
            return;
        }
        
        // Initialize if needed
        if (!window.scheduleAssignments) {
            window.scheduleAssignments = {};
        }
        if (!window.scheduleAssignments[bunk]) {
            window.scheduleAssignments[bunk] = new Array(window.unifiedTimes.length);
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
    // INITIALIZATION
    // =========================================================================

    function initScheduleSystem() {
        if (_initialized) return;
        
        const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        loadScheduleForDate(dateKey);
        updateTable();
        
        _initialized = true;
        if (DEBUG) console.log('[UnifiedSchedule] System initialized');
    }

    // Listen for data updates
    window.addEventListener('campistry-daily-data-updated', () => {
        if (DEBUG) console.log('[UnifiedSchedule] Data update event received');
        const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        loadScheduleForDate(dateKey);
        updateTable();
    });

    // =========================================================================
    // EXPORTS
    // =========================================================================

    window.updateTable = updateTable;
    window.renderStaggeredView = renderStaggeredView;
    window.initScheduleSystem = initScheduleSystem;
    window.saveSchedule = saveSchedule;
    window.loadScheduleForDate = loadScheduleForDate;
    
    // Compatibility exports
    window.findFirstSlotForTime = findFirstSlotForTime;
    window.findSlotsForRange = findSlotsForRange;
    window.parseTimeToMinutes = parseTimeToMinutes;
    window.minutesToTimeLabel = minutesToTimeLabel;
    window.getEntry = getEntry;
    window.formatEntry = formatEntry;
    window.editCell = editCell;
    
    // For debugging
    window.UnifiedScheduleSystem = {
        loadScheduleForDate,
        renderStaggeredView,
        findFirstSlotForTime,
        findSlotsForRange,
        getLeagueMatchups,
        DEBUG_ON: () => { DEBUG = true; },
        DEBUG_OFF: () => { DEBUG = false; }
    };

    console.log('📅 Unified Schedule System v1.0 loaded successfully');
    console.log('   Replaces: scheduler_ui.js, render_sync_fix.js, view_schedule_loader_fix.js');

})();
