// =================================================================
// ui_render_fix.js - FIX FOR SLOT RENDERING MISMATCH
// =================================================================
// Problem: getEntryForBlock uses unifiedTimes to look up slot times,
// but scheduleAssignments is indexed using divisionTimes[divName].
// This causes the UI to show wrong data or empty cells.
// =================================================================
(function() {
    'use strict';
    
    console.log('🔧 UI Render Fix loading...');
    
    // =========================================================================
    // HELPER: Get division for a bunk
    // =========================================================================
    function getDivisionForBunk(bunkName) {
        const divisions = window.divisions || {};
        for (const [divName, divData] of Object.entries(divisions)) {
            const bunks = divData.bunks || [];
            // Check with type coercion
            if (bunks.includes(bunkName) || 
                bunks.includes(String(bunkName)) || 
                bunks.some(b => String(b) === String(bunkName))) {
                return divName;
            }
        }
        return null;
    }
    
    // =========================================================================
    // FIXED: getEntryForBlock using division-specific times
    // =========================================================================
    function getEntryForBlockFixed(bunk, startMin, endMin, unifiedTimes) {
        const assignments = window.scheduleAssignments || {};
        
        if (!assignments[bunk]) {
            // Fallback for missing bunk
            return { entry: null, slotIdx: -1 };
        }
        
        const bunkData = assignments[bunk];
        
        // ★★★ KEY FIX: Get the division and use divisionTimes ★★★
        const divName = getDivisionForBunk(bunk);
        const divSlots = divName ? (window.divisionTimes?.[divName] || []) : [];
        
        // If we have division-specific times, use those for lookup
        if (divSlots.length > 0) {
            // Method 1: Find slot by time match using division slots
            for (let slotIdx = 0; slotIdx < bunkData.length && slotIdx < divSlots.length; slotIdx++) {
                const entry = bunkData[slotIdx];
                if (!entry || entry.continuation) continue;
                
                const slotStart = divSlots[slotIdx]?.startMin;
                if (slotStart !== undefined && slotStart >= startMin && slotStart < endMin) {
                    return { entry, slotIdx };
                }
            }
            
            // Method 2: Find slot index for the time range using divisionTimes
            for (let i = 0; i < divSlots.length; i++) {
                const slot = divSlots[i];
                if (slot.startMin >= startMin && slot.startMin < endMin) {
                    const entry = bunkData[i];
                    if (entry && !entry.continuation) {
                        return { entry, slotIdx: i };
                    }
                    // Even if no entry, return the correct slot index
                    return { entry: entry || null, slotIdx: i };
                }
            }
        }
        
        // Method 3: Check if entry has embedded time info
        for (let slotIdx = 0; slotIdx < bunkData.length; slotIdx++) {
            const entry = bunkData[slotIdx];
            if (!entry || entry.continuation) continue;
            
            const entryStartMin = entry._blockStart || entry._startMin || entry.startMin;
            if (entryStartMin !== undefined && entryStartMin >= startMin && entryStartMin < endMin) {
                return { entry, slotIdx };
            }
        }
        
        // Fallback: Try the old unified times method (for backwards compat)
        if (unifiedTimes && unifiedTimes.length > 0) {
            for (let slotIdx = 0; slotIdx < bunkData.length; slotIdx++) {
                const entry = bunkData[slotIdx];
                if (!entry || entry.continuation) continue;
                
                const slot = unifiedTimes[slotIdx];
                if (!slot) continue;
                
                let slotStart;
                if (slot.startMin !== undefined) {
                    slotStart = slot.startMin;
                } else if (slot.start) {
                    const d = new Date(slot.start);
                    slotStart = d.getHours() * 60 + d.getMinutes();
                }
                
                if (slotStart !== undefined && slotStart >= startMin && slotStart < endMin) {
                    return { entry, slotIdx };
                }
            }
        }
        
        return { entry: null, slotIdx: -1 };
    }
    
    // =========================================================================
    // APPLY PATCH
    // =========================================================================
    function applyPatch() {
        if (typeof window.getEntryForBlock === 'function') {
            const original = window.getEntryForBlock;
            window.getEntryForBlock = getEntryForBlockFixed;
            window._originalGetEntryForBlock = original;
            console.log('✅ Patched getEntryForBlock to use division-specific times');
        } else {
            // Function doesn't exist yet, wait for it
            setTimeout(applyPatch, 200);
            return;
        }
        
        // Also expose for modules that might have cached the function
        if (window.ScheduleUI) {
            window.ScheduleUI.getEntryForBlock = getEntryForBlockFixed;
        }
    }
    
    // =========================================================================
    // ALSO FIX: findSlotsForRange should use division times when given a bunk
    // =========================================================================
    function patchFindSlotsForRange() {
        const original = window.findSlotsForRange;
        if (typeof original !== 'function') {
            setTimeout(patchFindSlotsForRange, 200);
            return;
        }
        
        // Only patch if not already patched
        if (original._divTimePatched) return;
        
        window.findSlotsForRange = function(startMin, endMin, unifiedTimesOrDivisionOrBunk) {
            if (startMin === null || endMin === null) return [];
            
            // If string, try to treat as bunk or division name
            if (typeof unifiedTimesOrDivisionOrBunk === 'string' && window.divisionTimes) {
                let divName = unifiedTimesOrDivisionOrBunk;
                
                // Check if it's a bunk name, find its division
                const possibleDiv = getDivisionForBunk(unifiedTimesOrDivisionOrBunk);
                if (possibleDiv) {
                    divName = possibleDiv;
                }
                
                // If we have division times for this division, use them
                const divSlots = window.divisionTimes[divName];
                if (divSlots && divSlots.length > 0) {
                    const slots = [];
                    for (let i = 0; i < divSlots.length; i++) {
                        const slot = divSlots[i];
                        // Check for overlap (not completely before or completely after)
                        if (!(slot.endMin <= startMin || slot.startMin >= endMin)) {
                            slots.push(i);
                        }
                    }
                    return slots;
                }
            }
            
            // Fallback to original behavior
            return original.call(this, startMin, endMin, unifiedTimesOrDivisionOrBunk);
        };
        
        window.findSlotsForRange._divTimePatched = true;
        console.log('✅ Patched findSlotsForRange to support division/bunk names');
    }
    
    // =========================================================================
    // DIAGNOSTIC
    // =========================================================================
    function diagnose() {
        console.log('\n' + '═'.repeat(60));
        console.log('🔧 UI RENDER FIX DIAGNOSTIC');
        console.log('═'.repeat(60));
        
        const bunk = "1";
        const divName = getDivisionForBunk(bunk);
        console.log(`\nTest bunk: "${bunk}" → Division: "${divName}"`);
        
        const divSlots = window.divisionTimes?.[divName] || [];
        console.log(`Division slots: ${divSlots.length}`);
        
        const bunkData = window.scheduleAssignments?.[bunk] || [];
        console.log(`Bunk assignments: ${bunkData.length} slots`);
        
        console.log('\nSlot alignment check:');
        for (let i = 0; i < Math.min(divSlots.length, bunkData.length, 10); i++) {
            const slot = divSlots[i];
            const entry = bunkData[i];
            const entryText = entry ? (entry._activity || entry.field || 'FILLED') : 'EMPTY';
            console.log(`  [${i}] ${slot?.event || '?'} (${slot?.startMin || '?'}-${slot?.endMin || '?'}): ${entryText}`);
        }
        
        // Test the fixed function
        console.log('\nFixed lookup test:');
        divSlots.slice(0, 5).forEach((slot, i) => {
            const result = getEntryForBlockFixed(bunk, slot.startMin, slot.endMin, window.unifiedTimes);
            console.log(`  Block ${i} (${slot.startMin}-${slot.endMin}): slotIdx=${result.slotIdx}, entry=${result.entry?._activity || result.entry?.field || 'null'}`);
        });
        
        console.log('\n' + '═'.repeat(60));
    }
    
    // =========================================================================
    // EXPOSE
    // =========================================================================
    window.UIRenderFix = {
        diagnose,
        getEntryForBlockFixed,
        getDivisionForBunk,
        reapply: () => {
            applyPatch();
            patchFindSlotsForRange();
            window.updateTable?.();
        }
    };
    
    // =========================================================================
    // INIT
    // =========================================================================
    applyPatch();
    patchFindSlotsForRange();
    
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('🔧 UI RENDER FIX LOADED');
    console.log('');
    console.log('   Commands:');
    console.log('   - UIRenderFix.diagnose()   → Check alignment');
    console.log('   - UIRenderFix.reapply()    → Re-patch and refresh');
    console.log('   - updateTable()            → Refresh view');
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    
})();
