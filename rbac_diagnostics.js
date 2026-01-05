// ============================================================================
// rbac_diagnostics.js — RBAC Troubleshooting Utility
// ============================================================================
// Run this in the browser console to diagnose RBAC issues
// Usage: Include this script, then call window.RBACDiagnostics.runAll()
// ============================================================================

(function() {
    'use strict';

    const RBACDiagnostics = {
        
        /**
         * Run all diagnostics
         */
        async runAll() {
            console.log("🔍 ========== RBAC DIAGNOSTICS ==========");
            console.log("Running at:", new Date().toISOString());
            console.log("");
            
            await this.checkSupabaseConnection();
            await this.checkCurrentUser();
            await this.checkUserRole();
            await this.checkSubdivisions();
            await this.checkEditableDivisions();
            await this.checkWindowDivisions();
            await this.testPermissions();
            
            console.log("🔍 ========================================");
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
         * Test specific permissions
         */
        testPermissions() {
            console.log("🔒 PERMISSION TESTS:");
            
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
    
    console.log("🔍 RBAC Diagnostics loaded. Run: RBACDiagnostics.runAll()");

})();
