// ============================================================================
// rbac_loader.js — Master Loader for RBAC System
// ============================================================================
// Loads all RBAC modules in the correct order
// Include this single file in your HTML to enable the full RBAC system
// ============================================================================

(function() {
    'use strict';

    console.log("📦 RBAC Loader starting...");

    const RBAC_MODULES = [
        'access_control.js',
        'division_selector.js',
        'edit_restrictions.js',
        'team_subdivisions_ui.js',
        'rbac_integration.js'
    ];

    // Determine base path
    function getBasePath() {
        // Check current script location
        const scripts = document.getElementsByTagName('script');
        for (const script of scripts) {
            if (script.src.includes('rbac_loader.js')) {
                return script.src.replace('rbac_loader.js', '');
            }
        }
        // Default to current directory
        return './';
    }

    // Load a script and return a promise
    function loadScript(src) {
        return new Promise((resolve, reject) => {
            // Check if already loaded
            const existing = document.querySelector(`script[src*="${src}"]`);
            if (existing) {
                resolve();
                return;
            }

            const script = document.createElement('script');
            script.src = src;
            script.onload = resolve;
            script.onerror = () => reject(new Error(`Failed to load ${src}`));
            document.head.appendChild(script);
        });
    }

    // Load all modules sequentially
    async function loadAllModules() {
        const basePath = getBasePath();

        for (const module of RBAC_MODULES) {
            try {
                await loadScript(basePath + module);
                console.log(`📦 Loaded: ${module}`);
            } catch (e) {
                console.error(`📦 Failed to load ${module}:`, e);
            }
        }

        console.log("📦 All RBAC modules loaded");

        // Dispatch event when ready
        window.dispatchEvent(new CustomEvent('rbac-ready'));
    }

    // Start loading when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', loadAllModules);
    } else {
        loadAllModules();
    }

})();
