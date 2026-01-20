// =================================================================
// division_times_bunk_fix.js - FIX FOR BUNK LOOKUP & SLOT INIT
// =================================================================
// VERSION 1.0 - Fixes:
// 1. getDivisionForBunk type mismatch (string vs number)
// 2. Slot count initialization per division
// 3. Enhanced diagnostic to show actual data
// =================================================================
(function() {
    'use strict';
    
    console.log('🔧 Division Times Bunk Fix v1.0 loading...');
    
    // =========================================================================
    // FIX 1: IMPROVED getDivisionForBunk WITH TYPE COERCION
    // =========================================================================
    
    /**
     * Enhanced bunk-to-division lookup that handles:
     * - String vs number mismatches
     * - Leading zeros
     * - Different naming conventions
     */
    function getDivisionForBunkFixed(bunkName) {
        if (!bunkName) return null;
        
        const divisions = window.divisions || {};
        const bunkStr = String(bunkName).trim();
        const bunkNum = parseInt(bunkName, 10);
        const bunkLower = bunkStr.toLowerCase();
        
        for (const [divName, divData] of Object.entries(divisions)) {
            if (!divData.bunks || !Array.isArray(divData.bunks)) continue;
            
            // Try multiple matching strategies
            const found = divData.bunks.some(b => {
                if (b === bunkName) return true;  // Exact match
                if (String(b) === bunkStr) return true;  // String match
                if (!isNaN(bunkNum) && parseInt(b, 10) === bunkNum) return true;  // Numeric match
                if (String(b).toLowerCase() === bunkLower) return true;  // Case-insensitive
                return false;
            });
            
            if (found) {
                return divName;
            }
        }
        
        return null;
    }
    
    // =========================================================================
    // FIX 2: PATCH DivisionTimesSystem.getDivisionForBunk
    // =========================================================================
    
    function patchDivisionTimesSystem() {
        if (!window.DivisionTimesSystem) {
            console.log('[BunkFix] Waiting for DivisionTimesSystem...');
            setTimeout(patchDivisionTimesSystem, 100);
            return;
        }
        
        // Store original for reference
        const original = window.DivisionTimesSystem.getDivisionForBunk;
        
        // Patch with improved version
        window.DivisionTimesSystem.getDivisionForBunk = getDivisionForBunkFixed;
        
        // Also expose globally for other systems
        window.getDivisionForBunkFixed = getDivisionForBunkFixed;
        
        console.log('[BunkFix] ✅ Patched DivisionTimesSystem.getDivisionForBunk');
    }
    
    // =========================================================================
    // FIX 3: PATCH initializeBunkAssignments TO USE CORRECT SLOT COUNT
    // =========================================================================
    
    function patchBunkInitialization() {
        if (!window.DivisionTimesSystem) {
            setTimeout(patchBunkInitialization, 100);
            return;
        }
        
        const originalInit = window.DivisionTimesSystem.initializeBunkAssignments;
        
        window.DivisionTimesSystem.initializeBunkAssignments = function(bunkName) {
            const divName = getDivisionForBunkFixed(bunkName);
            const slots = window.DivisionTimesSystem.getSlotsForDivision(divName);
            const slotCount = slots.length || 8; // Fallback to 8 if division not found
            
            if (!window.scheduleAssignments) {
                window.scheduleAssignments = {};
            }
            
            if (!window.scheduleAssignments[bunkName]) {
                window.scheduleAssignments[bunkName] = new Array(slotCount).fill(null);
            } else if (window.scheduleAssignments[bunkName].length !== slotCount) {
                // Resize array - preserve existing data where possible
                const current = window.scheduleAssignments[bunkName];
                const newArr = new Array(slotCount).fill(null);
                const minLen = Math.min(current.length, slotCount);
                for (let i = 0; i < minLen; i++) {
                    newArr[i] = current[i];
                }
                window.scheduleAssignments[bunkName] = newArr;
            }
            
            return window.scheduleAssignments[bunkName];
        };
        
        console.log('[BunkFix] ✅ Patched initializeBunkAssignments');
    }
    
    // =========================================================================
    // FIX 4: ENHANCED DIAGNOSTIC
    // =========================================================================
    
    function enhancedDiagnose() {
        console.log('\n' + '═'.repeat(70));
        console.log('🔧 ENHANCED DIVISION TIMES DIAGNOSTIC (with bunk fix)');
        console.log('═'.repeat(70));
        
        // Check window.divisions structure
        console.log('\n=== DIVISION STRUCTURE ===');
        const divisions = window.divisions || {};
        const divisionTimes = window.divisionTimes || {};
        
        Object.entries(divisions).forEach(([divName, divData]) => {
            const bunks = divData.bunks || [];
            const slotCount = divisionTimes[divName]?.length || 0;
            console.log(`Division "${divName}": ${bunks.length} bunks, ${slotCount} slots`);
            console.log(`   Bunks: [${bunks.slice(0, 5).map(b => JSON.stringify(b)).join(', ')}${bunks.length > 5 ? ', ...' : ''}]`);
            console.log(`   Bunk types: ${[...new Set(bunks.map(b => typeof b))].join(', ')}`);
        });
        
        // Check scheduleAssignments
        console.log('\n=== SCHEDULE ASSIGNMENTS ===');
        const assignments = window.scheduleAssignments || {};
        const assignmentKeys = Object.keys(assignments);
        console.log(`Total bunks in assignments: ${assignmentKeys.length}`);
        console.log(`Sample bunk keys: [${assignmentKeys.slice(0, 5).map(b => JSON.stringify(b)).join(', ')}...]`);
        console.log(`Key types: ${[...new Set(assignmentKeys.map(b => typeof b))].join(', ')}`);
        
        // Test bunk lookups
        console.log('\n=== BUNK LOOKUP TEST ===');
        const testBunks = assignmentKeys.slice(0, 8);
        testBunks.forEach(bunk => {
            const oldLookup = window.DivisionTimesSystem?._originalGetDivisionForBunk?.(bunk) || 
                             (function() {
                                 for (const [dn, dd] of Object.entries(divisions)) {
                                     if (dd.bunks?.includes(bunk)) return dn;
                                 }
                                 return null;
                             })();
            const newLookup = getDivisionForBunkFixed(bunk);
            const status = oldLookup ? '✅' : (newLookup ? '🔧 FIXED' : '❌');
            console.log(`   Bunk "${bunk}": old=${oldLookup}, new=${newLookup} ${status}`);
        });
        
        // Check slot mismatches with corrected lookup
        console.log('\n=== SLOT ALIGNMENT (CORRECTED) ===');
        let correctCount = 0;
        let fixedCount = 0;
        let errorCount = 0;
        
        Object.entries(assignments).forEach(([bunk, slots]) => {
            const divName = getDivisionForBunkFixed(bunk);
            const expectedSlots = divisionTimes[divName]?.length || 0;
            const actualSlots = slots?.length || 0;
            const filled = (slots || []).filter(s => s && !s.continuation).length;
            
            if (!divName) {
                errorCount++;
            } else if (actualSlots === expectedSlots) {
                correctCount++;
            } else {
                fixedCount++;
                console.log(`   ⚠️ ${bunk} (div ${divName}): has ${actualSlots} slots, should have ${expectedSlots} (${filled} filled)`);
            }
        });
        
        console.log(`\nSummary: ${correctCount} correct, ${fixedCount} need resize, ${errorCount} no division found`);
        
        // Show how to fix
        if (fixedCount > 0) {
            console.log('\n💡 Run window.fixAllBunkSlotCounts() to resize mismatched arrays');
        }
        
        console.log('\n' + '═'.repeat(70));
    }
    
    // =========================================================================
    // FIX 5: UTILITY TO FIX ALL BUNK SLOT COUNTS
    // =========================================================================
    
    window.fixAllBunkSlotCounts = function() {
        console.log('[BunkFix] Fixing all bunk slot counts...');
        
        const divisions = window.divisions || {};
        const divisionTimes = window.divisionTimes || {};
        const assignments = window.scheduleAssignments || {};
        
        let fixedCount = 0;
        let errorCount = 0;
        
        Object.entries(assignments).forEach(([bunk, slots]) => {
            const divName = getDivisionForBunkFixed(bunk);
            
            if (!divName) {
                console.warn(`   ⚠️ ${bunk}: No division found - cannot fix`);
                errorCount++;
                return;
            }
            
            const expectedSlots = divisionTimes[divName]?.length || 0;
            const actualSlots = slots?.length || 0;
            
            if (expectedSlots === 0) {
                console.warn(`   ⚠️ ${bunk}: Division ${divName} has no slots defined`);
                errorCount++;
                return;
            }
            
            if (actualSlots !== expectedSlots) {
                // Resize the array
                const newArr = new Array(expectedSlots).fill(null);
                const minLen = Math.min(actualSlots, expectedSlots);
                
                for (let i = 0; i < minLen; i++) {
                    newArr[i] = slots[i];
                }
                
                // For bunks that had more slots, try to preserve by time matching
                if (actualSlots > expectedSlots && slots.length > expectedSlots) {
                    console.log(`   🔄 ${bunk}: Resizing from ${actualSlots} to ${expectedSlots} slots`);
                }
                
                window.scheduleAssignments[bunk] = newArr;
                fixedCount++;
            }
        });
        
        console.log(`[BunkFix] Fixed ${fixedCount} bunks, ${errorCount} errors`);
        
        // Refresh UI if available
        window.updateTable?.();
        
        return { fixed: fixedCount, errors: errorCount };
    };
    
    // =========================================================================
    // FIX 6: PATCH fillBlock TO USE CORRECT SLOT INITIALIZATION
    // =========================================================================
    
    function patchFillBlock() {
        if (typeof window.fillBlock !== 'function') {
            setTimeout(patchFillBlock, 200);
            return;
        }
        
        const originalFillBlock = window.fillBlock;
        
        window.fillBlock = function(block, pick, fieldUsageBySlot, yesterdayHistory, isRainyDay, activityProperties) {
            // Extract bunk name
            let bunk = block.bunk || block.team || block.bunkName;
            if (!bunk) {
                return originalFillBlock?.apply(this, arguments);
            }
            
            // Get correct division
            const divName = getDivisionForBunkFixed(bunk) || block.divName;
            
            // Ensure block has divName
            if (divName && !block.divName) {
                block.divName = divName;
            }
            
            // Ensure correct slot count
            if (divName && window.divisionTimes?.[divName]) {
                const expectedSlots = window.divisionTimes[divName].length;
                
                if (!window.scheduleAssignments[bunk]) {
                    window.scheduleAssignments[bunk] = new Array(expectedSlots).fill(null);
                } else if (window.scheduleAssignments[bunk].length !== expectedSlots) {
                    // Resize
                    const current = window.scheduleAssignments[bunk];
                    const newArr = new Array(expectedSlots).fill(null);
                    const minLen = Math.min(current.length, expectedSlots);
                    for (let i = 0; i < minLen; i++) {
                        newArr[i] = current[i];
                    }
                    window.scheduleAssignments[bunk] = newArr;
                }
            }
            
            return originalFillBlock.apply(this, arguments);
        };
        
        console.log('[BunkFix] ✅ Patched fillBlock for correct slot initialization');
    }
    
    // =========================================================================
    // FIX 7: PATCH scheduler_core_main STEP 1 INITIALIZATION
    // =========================================================================
    
    function patchSchedulerInit() {
        // This hooks into the scheduler to ensure bunks are initialized with correct slot counts
        window.addEventListener('campistry-generation-starting', function(e) {
            console.log('[BunkFix] Generation starting - ensuring correct slot counts...');
            
            const divisions = window.divisions || {};
            const divisionTimes = window.divisionTimes || {};
            
            Object.entries(divisions).forEach(([divName, divData]) => {
                const slotCount = divisionTimes[divName]?.length || 8;
                
                (divData.bunks || []).forEach(bunk => {
                    const bunkKey = String(bunk); // Normalize to string
                    
                    if (!window.scheduleAssignments[bunkKey]) {
                        window.scheduleAssignments[bunkKey] = new Array(slotCount).fill(null);
                    } else if (window.scheduleAssignments[bunkKey].length !== slotCount) {
                        // Only reset if it's wrong size
                        window.scheduleAssignments[bunkKey] = new Array(slotCount).fill(null);
                    }
                });
                
                console.log(`[BunkFix] Division ${divName}: ${(divData.bunks || []).length} bunks × ${slotCount} slots`);
            });
        });
        
        console.log('[BunkFix] ✅ Registered generation hook');
    }
    
    // =========================================================================
    // FIX 8: DETAILED SLOT FILL ANALYSIS
    // =========================================================================
    
    function analyzeSlotFilling() {
        console.log('\n' + '═'.repeat(70));
        console.log('📊 SLOT FILLING ANALYSIS');
        console.log('═'.repeat(70));
        
        const divisions = window.divisions || {};
        const divisionTimes = window.divisionTimes || {};
        const assignments = window.scheduleAssignments || {};
        
        // Group bunks by division
        const bunksByDivision = {};
        Object.entries(divisions).forEach(([divName, divData]) => {
            bunksByDivision[divName] = divData.bunks || [];
        });
        
        // Analyze each division
        Object.entries(divisionTimes).forEach(([divName, slots]) => {
            console.log(`\n📁 Division ${divName}: ${slots.length} slots`);
            
            const divBunks = bunksByDivision[divName] || [];
            const bunkKeys = divBunks.map(b => String(b));
            
            // Also find bunks in assignments that might belong to this division
            const assignedBunks = Object.keys(assignments).filter(bunk => 
                getDivisionForBunkFixed(bunk) === divName
            );
            
            const allBunks = [...new Set([...bunkKeys, ...assignedBunks])];
            
            if (allBunks.length === 0) {
                console.log('   ⚠️ No bunks found for this division!');
                return;
            }
            
            console.log(`   Found ${allBunks.length} bunks`);
            
            // For each slot, count how many bunks have it filled
            slots.forEach((slot, idx) => {
                let filledCount = 0;
                let emptyBunks = [];
                
                allBunks.forEach(bunk => {
                    const bunkSlots = assignments[bunk];
                    if (!bunkSlots || bunkSlots.length <= idx) {
                        emptyBunks.push(bunk);
                        return;
                    }
                    
                    const entry = bunkSlots[idx];
                    if (entry && !entry.continuation) {
                        filledCount++;
                    } else if (!entry) {
                        emptyBunks.push(bunk);
                    }
                });
                
                const fillPct = Math.round((filledCount / allBunks.length) * 100);
                const status = fillPct === 100 ? '✅' : (fillPct >= 50 ? '⚠️' : '❌');
                
                console.log(`   [${idx}] ${slot.label} | ${slot.event} (${slot.type}) | ${status} ${filledCount}/${allBunks.length} (${fillPct}%)`);
                
                if (emptyBunks.length > 0 && emptyBunks.length <= 5) {
                    console.log(`        Empty: ${emptyBunks.join(', ')}`);
                } else if (emptyBunks.length > 5) {
                    console.log(`        Empty: ${emptyBunks.slice(0, 3).join(', ')}... and ${emptyBunks.length - 3} more`);
                }
            });
        });
        
        // Summary
        console.log('\n=== SLOT TYPE SUMMARY ===');
        const slotTypeCounts = {};
        const slotTypeFilled = {};
        
        Object.entries(divisionTimes).forEach(([divName, slots]) => {
            const divBunks = bunksByDivision[divName] || [];
            const bunkKeys = divBunks.map(b => String(b));
            const assignedBunks = Object.keys(assignments).filter(bunk => 
                getDivisionForBunkFixed(bunk) === divName
            );
            const allBunks = [...new Set([...bunkKeys, ...assignedBunks])];
            
            slots.forEach((slot, idx) => {
                const type = slot.type || 'unknown';
                if (!slotTypeCounts[type]) {
                    slotTypeCounts[type] = 0;
                    slotTypeFilled[type] = 0;
                }
                slotTypeCounts[type]++;
                
                allBunks.forEach(bunk => {
                    const entry = assignments[bunk]?.[idx];
                    if (entry && !entry.continuation) {
                        slotTypeFilled[type]++;
                    }
                });
            });
        });
        
        Object.keys(slotTypeCounts).sort().forEach(type => {
            const total = slotTypeCounts[type];
            const filled = slotTypeFilled[type];
            const pct = Math.round((filled / (total * 10)) * 100); // Approximate
            console.log(`   ${type}: ${filled} filled / ~${total} slots per division`);
        });
        
        console.log('\n' + '═'.repeat(70));
    }
    
    // =========================================================================
    // EXPOSE ENHANCED DIAGNOSTIC
    // =========================================================================
    
    window.BunkFix = {
        diagnose: enhancedDiagnose,
        analyzeSlots: analyzeSlotFilling,
        fixSlotCounts: window.fixAllBunkSlotCounts,
        getDivisionForBunk: getDivisionForBunkFixed,
        version: '1.0'
    };
    
    // =========================================================================
    // FIX 9: AUTO-FILL MISSING PINNED SLOTS
    // =========================================================================
    
    window.fillMissingPinnedSlots = function() {
        console.log('[BunkFix] Filling missing pinned slots...');
        
        const divisions = window.divisions || {};
        const divisionTimes = window.divisionTimes || {};
        const assignments = window.scheduleAssignments || {};
        
        let filledCount = 0;
        
        Object.entries(divisionTimes).forEach(([divName, slots]) => {
            // Find bunks for this division
            const divBunks = (divisions[divName]?.bunks || []).map(b => String(b));
            const assignedBunks = Object.keys(assignments).filter(bunk => 
                getDivisionForBunkFixed(bunk) === divName
            );
            const allBunks = [...new Set([...divBunks, ...assignedBunks])];
            
            slots.forEach((slot, idx) => {
                // Only process pinned slots
                if (slot.type !== 'pinned') return;
                
                const eventName = slot.event || 'Pinned Event';
                
                allBunks.forEach(bunk => {
                    if (!assignments[bunk]) {
                        assignments[bunk] = new Array(slots.length).fill(null);
                    }
                    
                    // Check if this slot is empty
                    const entry = assignments[bunk][idx];
                    if (!entry) {
                        // Fill with pinned event
                        assignments[bunk][idx] = {
                            field: eventName,
                            sport: null,
                            _fixed: true,
                            _activity: eventName,
                            _pinned: true,
                            _startMin: slot.startMin,
                            _endMin: slot.endMin,
                            _slotIndex: idx,
                            _division: divName,
                            _autoFilled: true
                        };
                        filledCount++;
                    }
                });
            });
        });
        
        console.log(`[BunkFix] Filled ${filledCount} missing pinned slots`);
        window.updateTable?.();
        
        return filledCount;
    };
    
    // =========================================================================
    // FIX 10: HOOK INTO GENERATION COMPLETE TO AUTO-FIX
    // =========================================================================
    
    function hookGenerationComplete() {
        window.addEventListener('campistry-generation-complete', function(e) {
            console.log('[BunkFix] Generation complete - running auto-fixes...');
            
            // Give the scheduler a moment to finish all operations
            setTimeout(() => {
                // Fix slot counts
                const slotFixes = window.fixAllBunkSlotCounts();
                
                // Fill missing pinned slots
                const pinnedFills = window.fillMissingPinnedSlots();
                
                console.log(`[BunkFix] Post-generation fixes: ${slotFixes.fixed} slot resizes, ${pinnedFills} pinned fills`);
            }, 100);
        });
        
        console.log('[BunkFix] ✅ Registered generation complete hook');
    }
    
    // =========================================================================
    // INITIALIZATION
    // =========================================================================
    
    function init() {
        patchDivisionTimesSystem();
        patchBunkInitialization();
        patchFillBlock();
        patchSchedulerInit();
        hookGenerationComplete();
        
        console.log('═══════════════════════════════════════════════════════════════════════');
        console.log('🔧 DIVISION TIMES BUNK FIX v1.0 LOADED');
        console.log('');
        console.log('   Commands:');
        console.log('   - BunkFix.diagnose()            → Enhanced diagnostic');
        console.log('   - BunkFix.analyzeSlots()        → Detailed slot fill analysis');
        console.log('   - BunkFix.fixSlotCounts()       → Fix all mismatched slot arrays');
        console.log('   - fillMissingPinnedSlots()      → Auto-fill empty pinned slots');
        console.log('');
        console.log('═══════════════════════════════════════════════════════════════════════');
    }
    
    // Start initialization
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
    
})();
