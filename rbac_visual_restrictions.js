// ============================================================================
// rbac_visual_restrictions.js - v2.1 (VISUAL UPDATE: VIEW ALL, EDIT SOME)
// ============================================================================
// This version explicitly ALLOWS viewing of all divisions but restricts editing.
// It removes any logic that might hide columns or elements.
// ============================================================================

(function() {
    'use strict';

    console.log("🚫 Visual Restrictions v2.1 (VIEW ALL) loading...");

    class VisualRestrictions {
        constructor() {
            this.role = null;
            this.editableDivisions = [];
        }

        init(role, editableDivisions) {
            this.role = role;
            this.editableDivisions = editableDivisions || [];
            console.log(`🚫 Visual Restrictions initialized: {role: '${role}', editableDivisions: [${this.editableDivisions.join(', ')}]}`);
            
            // Apply styles for read-only cells
            this.applyReadonlyState();
        }

        applyReadonlyState() {
            const styleId = 'rbac-styles';
            let style = document.getElementById(styleId);
            if (!style) {
                style = document.createElement('style');
                style.id = styleId;
                document.head.appendChild(style);
            }

            // Define read-only styling
            // CRITICAL: We do NOT use display:none or visibility:hidden here.
            style.textContent = `
                .read-only-cell {
                    background-color: #f9f9f9 !important;
                    color: #777;
                    cursor: not-allowed;
                }
                .read-only-cell:hover {
                    background-color: #f9f9f9 !important;
                }
                /* Ensure columns are visible */
                th[data-division], td[data-division] {
                    display: table-cell !important;
                    visibility: visible !important;
                    opacity: 1 !important;
                }
            `;
        }

        // DEPRECATED & DISABLED: Previously used to hide columns. 
        // We override this to do nothing, ensuring full visibility.
        hideRestrictedDivisions() {
            console.log("🚫 [VisualRestrictions] Hiding logic disabled - allowing full schedule view.");
            // Force show any potentially hidden elements just in case CSS leaked
            const hidden = document.querySelectorAll('[data-division][style*="display: none"]');
            hidden.forEach(el => el.style.display = '');
        }
        
        // Helper to update state if RBAC reloads
        refresh(role, divs) {
            this.init(role, divs);
        }
    }

    // Expose instance
    window.VisualRestrictions = new VisualRestrictions();
    
    // Auto-hook into AccessControl if available
    if (window.AccessControl && window.AccessControl.isInitialized) {
        window.VisualRestrictions.init(
            window.AccessControl.getCurrentRole(),
            window.AccessControl.getEditableDivisions()
        );
    } else {
        // Listen for load
        window.addEventListener('campistry-access-loaded', (e) => {
             window.VisualRestrictions.init(e.detail.role, e.detail.editableDivisions);
        });
    }

})();
