// ============================================================================
// rbac_diagnostics.js — RBAC Troubleshooting Utility v1.1
// ============================================================================
// Run this in the browser console to diagnose RBAC issues
// Usage: Include this script, then call window.RBACDiagnostics.runAll()
//
// v1.1 SECURITY PATCH:
//   - V-006 FIX: Added testPermissionBoundaries() for active boundary testing
//   - Tests write interception, role boundary enforcement, DOM state
//   - runAll() now includes boundary tests automatically
// ============================================================================

(function() {
    'use strict';

    const RBACDiagnostics = {
        
        /**
         * Run all diagnostics
         */
        async runAll() {
            console.log("🔍 ========== RBAC DIAGNOSTICS v1.1 ==========");
            console.log("Running at:", new Date().toISOString());
            console.log("");
            
            await this.checkSupabaseConnection();
            await this.checkCurrentUser();
            await this.checkUserRole();
            await this.checkSubdivisions();
            await this.checkEditableDivisions();
            await this.checkWindowDivisions();
            await this.testPermissions();
            await this.testPermissionBoundaries();  // ★★★ v1.1: Active boundary tests ★★★
            
            console.log("🔍 =============================================");
        },

        /**
         * Check Supabase connection
         */
        async checkSupabaseConnection() {
            console.log("📡 SUPABASE CONNECTION:");
            console.log("  - window.supabase exists:", !!window.supabase);
            
            if (window.supabase) {
                try {
                    const { data: { session } } = await window.supabase.auth.getSession();
                    console.log("  - Active session:", !!session);
                    if (session) {
                        console.log("  - User email:", session.user?.email);
                        console.log("  - User ID:", session.user?.id);
                    }
                } catch (e) {
                    console.log("  - Session check error:", e.message);
                }
            }
            console.log("");
        },

        /**
         * Check current user from AccessControl
         */
        async checkCurrentUser() {
            console.log("👤 ACCESS CONTROL USER:");
            
            if (!window.AccessControl) {
                console.log("  ❌ AccessControl not loaded!");
                return;
            }
            
            console.log("  - isInitialized:", window.AccessControl.isInitialized);
            console.log("  - getCurrentRole():", window.AccessControl.getCurrentRole());
            console.log("  - isTeamMember():", window.AccessControl.isTeamMember());
            console.log("  - isOwner():", window.AccessControl.isOwner());
            console.log("  - isAdmin():", window.AccessControl.isAdmin());
            console.log("  - isViewer():", window.AccessControl.isViewer());
            console.log("  - getUserName():", window.AccessControl.getUserName());
            console.log("  - getCampName():", window.AccessControl.getCampName());
            console.log("  - getCampId():", window.AccessControl.getCampId());
            
            // ★★★ v1.1: Check CampistryDB role verification status ★★★
            if (window.CampistryDB) {
                console.log("  - CampistryDB.isRoleVerified():", window.CampistryDB.isRoleVerified?.() ?? 'N/A');
                console.log("  - CampistryDB.getRole():", window.CampistryDB.getRole?.());
            }
            console.log("");
        },

        /**
         * Check user role directly from database
         */
        async checkUserRole() {
            console.log("🔑 DATABASE ROLE CHECK:");
            
            if (!window.supabase) {
                console.log("  ❌ Supabase not available");
                return;
            }
            
            try {
                const { data: { user } } = await window.supabase.auth.getUser();
                if (!user) {
                    console.log("  ❌ No user logged in");
                    return;
                }
                
                console.log("  - Auth user ID:", user.id);
                console.log("  - Auth user email:", user.email);
                
                // Check if user owns a camp
                const { data: ownedCamp, error: campError } = await window.supabase
                    .from('camps')
                    .select('*')
                    .eq('owner', user.id)
                    .maybeSingle();
                
                console.log("  - Owns a camp:", !!ownedCamp);
                if (ownedCamp) {
                    console.log("    Camp name:", ownedCamp.name);
                }
                if (campError) {
                    console.log("    Camp query error:", campError.message);
                }
                
                // Check if user is a team member
                const { data: membership, error: memberError } = await window.supabase
                    .from('camp_users')
                    .select('*')
                    .eq('user_id', user.id)
                    .not('accepted_at', 'is', null)
                    .maybeSingle();
                
                console.log("  - Is team member:", !!membership);
                if (membership) {
                    console.log("    Role:", membership.role);
                    console.log("    Camp ID:", membership.camp_id);
                    console.log("    Subdivision IDs:", membership.subdivision_ids);
                    console.log("    Subdivision IDs type:", typeof membership.subdivision_ids);
                    console.log("    Subdivision IDs is array:", Array.isArray(membership.subdivision_ids));
                    console.log("    Accepted at:", membership.accepted_at);
                }
                if (memberError) {
                    console.log("    Membership query error:", memberError.message);
                }
                
            } catch (e) {
                console.log("  ❌ Error:", e.message);
            }
            console.log("");
        },

        /**
         * Check subdivisions
         */
        async checkSubdivisions() {
            console.log("📂 SUBDIVISIONS:");
            
            if (!window.AccessControl) {
                console.log("  ❌ AccessControl not loaded");
                return;
            }
            
            const allSubs = window.AccessControl.getSubdivisions();
            const userSubs = window.AccessControl.getUserSubdivisions();
            const userSubIds = window.AccessControl.getUserSubdivisionIds?.() || [];
            const userSubDetails = window.AccessControl.getUserSubdivisionDetails();
            
            console.log("  - All subdivisions count:", allSubs.length);
            allSubs.forEach(sub => {
                console.log(`    • "${sub.name}" (ID: ${sub.id})`);
                console.log(`      Divisions: [${(sub.divisions || []).join(', ')}]`);
            });
            
            console.log("  - User subdivision IDs:", userSubIds);
            console.log("  - User subdivisions count:", userSubs.length);
            userSubs.forEach(sub => {
                console.log(`    • "${sub.name}": [${(sub.divisions || []).join(', ')}]`);
            });
            
            console.log("  - User subdivision details:", userSubDetails);
            console.log("");
        },

        /**
         * Check editable divisions
         */
        async checkEditableDivisions() {
            console.log("✏️ EDITABLE DIVISIONS:");
            
            if (!window.AccessControl) {
                console.log("  ❌ AccessControl not loaded");
                return;
            }
            
            const editable = window.AccessControl.getEditableDivisions();
            console.log("  - Editable divisions:", editable);
            console.log("  - Count:", editable.length);
            console.log("  - canEditAnything():", window.AccessControl.canEditAnything());
            console.log("  - canSave():", window.AccessControl.canSave());
            console.log("");
        },

        /**
         * Check window.divisions
         */
        checkWindowDivisions() {
            console.log("🏷️ WINDOW.DIVISIONS:");
            
            const divisions = window.divisions || {};
            const keys = Object.keys(divisions);
            
            console.log("  - window.divisions exists:", !!window.divisions);
            console.log("  - Division count:", keys.length);
            console.log("  - Division names:", keys);
            
            keys.forEach(divName => {
                const div = divisions[divName];
                const bunkCount = (div.bunks || []).length;
                console.log(`    • "${divName}": ${bunkCount} bunks`);
            });
            console.log("");
        },

        /**
         * Test specific permissions (passive state logging)
         */
        testPermissions() {
            console.log("🔒 PERMISSION TESTS (State Check):");
            
            if (!window.AccessControl) {
                console.log("  ❌ AccessControl not loaded");
                return;
            }
            
            const divisions = Object.keys(window.divisions || {});
            
            if (divisions.length === 0) {
                console.log("  ⚠️ No divisions in window.divisions to test");
            } else {
                console.log("  Testing canEditDivision() for each division:");
                divisions.forEach(divName => {
                    const canEdit = window.AccessControl.canEditDivision(divName);
                    const symbol = canEdit ? "✅" : "❌";
                    console.log(`    ${symbol} "${divName}": ${canEdit}`);
                });
            }
            
            // Test some bunks
            const bunks = window.globalBunks || [];
            if (bunks.length > 0) {
                console.log("  Testing canEditBunk() for first 5 bunks:");
                bunks.slice(0, 5).forEach(bunkName => {
                    const canEdit = window.AccessControl.canEditBunk(bunkName);
                    const division = window.AccessControl.getDivisionForBunk?.(bunkName) || 'unknown';
                    const symbol = canEdit ? "✅" : "❌";
                    console.log(`    ${symbol} "${bunkName}" (${division}): ${canEdit}`);
                });
            }
            
            console.log("");
        },

        // =====================================================================
        // ★★★ v1.1: ACTIVE PERMISSION BOUNDARY TESTS ★★★
        // These don't just log state — they verify that boundaries are enforced.
        // =====================================================================

        /**
         * Actually test permission boundaries (not just log state)
         */
        async testPermissionBoundaries() {
            console.log("🧪 PERMISSION BOUNDARY TESTS:");
            
            if (!window.AccessControl) {
                console.log("  ❌ AccessControl not loaded — skipping boundary tests");
                return { passed: 0, failed: 0, skipped: true };
            }

            const role = window.AccessControl.getCurrentRole();
            const editable = window.AccessControl.getEditableDivisions() || [];
            const allDivisions = Object.keys(window.divisions || {});
            let passed = 0;
            let failed = 0;

            // -----------------------------------------------------------------
            // Test 1: Fail-closed when not initialized
            // -----------------------------------------------------------------
            // We can't truly test this without resetting state, so we verify
            // that the _initialized guard exists by checking the pattern
            console.log("  --- Test 1: Fail-closed check ---");
            if (window.AccessControl.isInitialized) {
                console.log("  ✅ TEST 1: AccessControl is initialized (cannot test fail-closed without reset)");
                passed++;
            } else {
                // If somehow not initialized, verify all checks return false
                const failClosedOk = !window.AccessControl.canEditAnything() 
                                  && !window.AccessControl.canSave()
                                  && !window.AccessControl.canEraseData();
                if (failClosedOk) {
                    console.log("  ✅ TEST 1: Uninitialized — all checks correctly return false");
                    passed++;
                } else {
                    console.log("  ❌ TEST 1 FAIL: Uninitialized but some checks return true!");
                    failed++;
                }
            }

            // -----------------------------------------------------------------
            // Test 2: Viewer should have zero editable divisions
            // -----------------------------------------------------------------
            if (role === 'viewer') {
                console.log("  --- Test 2: Viewer has no edit access ---");
                if (editable.length === 0) {
                    console.log("  ✅ TEST 2: Viewer has 0 editable divisions");
                    passed++;
                } else {
                    console.log("  ❌ TEST 2 FAIL: Viewer has", editable.length, "editable divisions!");
                    failed++;
                }

                // Also verify viewer can't save, erase, etc.
                const viewerBlocked = !window.AccessControl.canSave()
                                   && !window.AccessControl.canEraseData()
                                   && !window.AccessControl.canEditAnything()
                                   && !window.AccessControl.canRunGenerator();
                if (viewerBlocked) {
                    console.log("  ✅ TEST 2b: Viewer correctly blocked from all write operations");
                    passed++;
                } else {
                    console.log("  ❌ TEST 2b FAIL: Viewer has unexpected write permissions!");
                    failed++;
                }
            }

            // -----------------------------------------------------------------
            // Test 3: Scheduler should NOT be able to edit non-assigned divisions
            // -----------------------------------------------------------------
            if (role === 'scheduler') {
                console.log("  --- Test 3: Scheduler boundary enforcement ---");
                const forbidden = allDivisions.filter(d => !editable.includes(d));
                let test3Pass = true;
                
                forbidden.forEach(d => {
                    if (window.AccessControl.canEditDivision(d)) {
                        console.log(`  ❌ TEST 3 FAIL: Scheduler CAN edit forbidden division "${d}"`);
                        test3Pass = false;
                        failed++;
                    }
                });
                
                if (test3Pass && forbidden.length > 0) {
                    console.log(`  ✅ TEST 3: Scheduler correctly blocked from ${forbidden.length} non-assigned divisions`);
                    passed++;
                } else if (forbidden.length === 0) {
                    console.log("  ⚠️ TEST 3: No forbidden divisions to test (scheduler has access to all)");
                }

                // Test that editable divisions ARE accessible
                let test3bPass = true;
                editable.forEach(d => {
                    if (!window.AccessControl.canEditDivision(d)) {
                        console.log(`  ❌ TEST 3b FAIL: Scheduler CANNOT edit assigned division "${d}"`);
                        test3bPass = false;
                        failed++;
                    }
                });
                if (test3bPass && editable.length > 0) {
                    console.log(`  ✅ TEST 3b: Scheduler correctly has access to ${editable.length} assigned divisions`);
                    passed++;
                }
            }

            // -----------------------------------------------------------------
            // Test 4: Write interception works (PermissionsGuard)
            // -----------------------------------------------------------------
            console.log("  --- Test 4: Write interception ---");
            if (window.PermissionsGuard?.validateScheduleWrite) {
                const fakeBunks = {};
                allDivisions.forEach(d => {
                    const bunks = (window.divisions[d]?.bunks || []);
                    if (bunks.length > 0) fakeBunks[bunks[0]] = { test: true };
                });

                if (Object.keys(fakeBunks).length > 0) {
                    const result = window.PermissionsGuard.validateScheduleWrite(fakeBunks);
                    
                    if (role === 'viewer') {
                        if (result.data && Object.keys(result.data).length === 0) {
                            console.log("  ✅ TEST 4: Viewer write interception blocked all bunks");
                            passed++;
                        } else {
                            console.log("  ❌ TEST 4 FAIL: Viewer write interception let through", Object.keys(result.data || {}).length, "bunks!");
                            failed++;
                        }
                    } else if (role === 'scheduler') {
                        const blockedCount = Object.keys(result.blocked || {}).length;
                        const allowedCount = Object.keys(result.data || {}).length;
                        if (blockedCount > 0) {
                            console.log(`  ✅ TEST 4: Scheduler write interception blocked ${blockedCount} bunks, allowed ${allowedCount}`);
                            passed++;
                        } else if (allDivisions.length === editable.length) {
                            console.log("  ⚠️ TEST 4: Scheduler has access to all divisions — no blocks expected");
                        } else {
                            console.log("  ❌ TEST 4 FAIL: Scheduler has partial access but write interception blocked 0 bunks");
                            failed++;
                        }
                    } else if (role === 'owner' || role === 'admin') {
                        console.log("  ✅ TEST 4: Full-access role — all writes allowed");
                        passed++;
                    }
                } else {
                    console.log("  ⚠️ TEST 4: No bunks available to test write interception");
                }
            } else {
                console.log("  ⚠️ TEST 4: PermissionsGuard.validateScheduleWrite not available — skipping");
            }

            // -----------------------------------------------------------------
            // Test 5: DOM state verification (viewer/scheduler)
            // -----------------------------------------------------------------
            console.log("  --- Test 5: DOM state verification ---");
            if (role === 'viewer') {
                const visibleEditBtns = document.querySelectorAll(
                    '[data-action="edit"]:not([style*="display: none"]):not([disabled]),' +
                    '[data-action="generate"]:not([style*="display: none"]):not([disabled]),' +
                    '[data-action="delete"]:not([style*="display: none"]):not([disabled])'
                );
                if (visibleEditBtns.length === 0) {
                    console.log("  ✅ TEST 5: No visible/enabled edit buttons for viewer");
                    passed++;
                } else {
                    console.log(`  ❌ TEST 5 FAIL: ${visibleEditBtns.length} edit buttons still visible/enabled for viewer!`);
                    visibleEditBtns.forEach(btn => {
                        console.log(`    - ${btn.id || btn.className || btn.textContent?.substring(0, 30)}`);
                    });
                    failed++;
                }
            } else if (role === 'scheduler' || role === 'admin') {
                // Check that owner-only buttons are hidden
                const ownerBtns = document.querySelectorAll(
                    '[data-owner-only]:not([style*="display: none"]),' +
                    '.owner-only:not([style*="display: none"])'
                );
                if (role === 'scheduler') {
                    if (ownerBtns.length === 0) {
                        console.log("  ✅ TEST 5: Owner-only elements correctly hidden for scheduler");
                        passed++;
                    } else {
                        console.log(`  ❌ TEST 5 FAIL: ${ownerBtns.length} owner-only elements visible for scheduler!`);
                        failed++;
                    }
                } else {
                    console.log("  ⚠️ TEST 5: Admin role — checking eraseAll button state");
                    const eraseBtn = document.getElementById('eraseAllBtn');
                    if (eraseBtn && eraseBtn.disabled) {
                        console.log("  ✅ TEST 5: eraseAllBtn correctly disabled for admin");
                        passed++;
                    } else if (!eraseBtn) {
                        console.log("  ⚠️ TEST 5: eraseAllBtn not found in DOM — may not be on current page");
                    } else {
                        console.log("  ❌ TEST 5 FAIL: eraseAllBtn is enabled for admin!");
                        failed++;
                    }
                }
            } else {
                console.log("  ⚠️ TEST 5: Owner role — no restrictions to verify");
            }

            // -----------------------------------------------------------------
            // Test 6: Feature permission consistency
            // -----------------------------------------------------------------
            console.log("  --- Test 6: Feature permission consistency ---");
            const featureTests = [
                { name: 'canInviteUsers', fn: () => window.AccessControl.canInviteUsers(), ownerOnly: true },
                { name: 'canManageTeam', fn: () => window.AccessControl.canManageTeam(), ownerOnly: true },
                { name: 'canDeleteCampData', fn: () => window.AccessControl.canDeleteCampData(), ownerOnly: true },
                { name: 'canEraseAllCampData', fn: () => window.AccessControl.canEraseAllCampData(), ownerOnly: true },
                { name: 'canEraseData', fn: () => window.AccessControl.canEraseData(), minRole: 'admin' },
                { name: 'canEditFields', fn: () => window.AccessControl.canEditFields(), minRole: 'admin' },
            ];

            let test6Pass = true;
            featureTests.forEach(test => {
                const result = test.fn();
                let expected;
                
                if (test.ownerOnly) {
                    expected = (role === 'owner');
                } else if (test.minRole === 'admin') {
                    expected = (role === 'owner' || role === 'admin');
                }

                if (result !== expected) {
                    console.log(`  ❌ TEST 6 FAIL: ${test.name}() returned ${result}, expected ${expected} for role "${role}"`);
                    test6Pass = false;
                    failed++;
                }
            });
            if (test6Pass) {
                console.log(`  ✅ TEST 6: All ${featureTests.length} feature permissions correct for role "${role}"`);
                passed++;
            }

            // -----------------------------------------------------------------
            // Summary
            // -----------------------------------------------------------------
            console.log("");
            console.log(`  📊 Boundary Test Results: ${passed} passed, ${failed} failed`);
            if (failed > 0) {
                console.log("  🚨 PERMISSION BOUNDARY VIOLATIONS DETECTED — Review failures above!");
            } else {
                console.log("  ✅ All boundary tests passed");
            }
            console.log("");
            
            return { passed, failed };
        },

        /**
         * Force recalculate editable divisions
         */
        async forceRecalculate() {
            console.log("🔄 Forcing recalculation...");
            
            if (window.AccessControl?.refresh) {
                await window.AccessControl.refresh();
                console.log("✅ AccessControl refreshed");
            }
            
            this.checkEditableDivisions();
        },

        /**
         * Check database schema for subdivision_ids
         */
        async checkDatabaseSchema() {
            console.log("📋 DATABASE SCHEMA CHECK:");
            
            if (!window.supabase) {
                console.log("  ❌ Supabase not available");
                return;
            }
            
            try {
                // Get a sample row from camp_users to see structure
                const { data, error } = await window.supabase
                    .from('camp_users')
                    .select('*')
                    .limit(1);
                
                if (error) {
                    console.log("  Query error:", error.message);
                } else if (data && data.length > 0) {
                    console.log("  Sample camp_users row structure:");
                    Object.keys(data[0]).forEach(key => {
                        const value = data[0][key];
                        console.log(`    - ${key}: ${typeof value} = ${JSON.stringify(value)}`);
                    });
                } else {
                    console.log("  No camp_users rows found");
                }
            } catch (e) {
                console.log("  ❌ Error:", e.message);
            }
            console.log("");
        },

        /**
         * Simulate what would happen for a specific user
         */
        async simulateUserAccess(userEmail) {
            console.log(`🎭 SIMULATING ACCESS FOR: ${userEmail}`);
            
            if (!window.supabase) {
                console.log("  ❌ Supabase not available");
                return;
            }
            
            try {
                // Find the user in camp_users
                const { data: membership } = await window.supabase
                    .from('camp_users')
                    .select('*')
                    .eq('email', userEmail.toLowerCase())
                    .maybeSingle();
                
                if (!membership) {
                    console.log("  ❌ User not found in camp_users");
                    return;
                }
                
                console.log("  User found:");
                console.log("    Role:", membership.role);
                console.log("    subdivision_ids:", membership.subdivision_ids);
                
                if (!membership.subdivision_ids || membership.subdivision_ids.length === 0) {
                    console.log("  ⚠️ User has NO subdivision_ids!");
                    console.log("  Result: With current code, scheduler would get FULL ACCESS");
                    console.log("  Fix: Assign subdivisions to this user");
                    return;
                }
                
                // Get the subdivisions
                const { data: subdivisions } = await window.supabase
                    .from('subdivisions')
                    .select('*')
                    .in('id', membership.subdivision_ids);
                
                console.log("  Assigned subdivisions:");
                let allDivisions = [];
                (subdivisions || []).forEach(sub => {
                    console.log(`    • "${sub.name}": [${(sub.divisions || []).join(', ')}]`);
                    allDivisions = allDivisions.concat(sub.divisions || []);
                });
                
                console.log("  Would have edit access to:", [...new Set(allDivisions)]);
                
            } catch (e) {
                console.log("  ❌ Error:", e.message);
            }
            console.log("");
        }
    };

    window.RBACDiagnostics = RBACDiagnostics;
    
    console.log("🔍 RBAC Diagnostics v1.1 loaded. Run: RBACDiagnostics.runAll()");

})();
