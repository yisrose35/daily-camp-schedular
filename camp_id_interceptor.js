// =============================================================================
// camp_id_interceptor.js — MUST LOAD BEFORE cloud_storage_bridge.js
// =============================================================================
// This tiny script intercepts console.log to capture the camp ID when
// cloud_storage_bridge logs "Loading from cloud for camp: XXX"
// =============================================================================

(function() {
    'use strict';
    
    const originalLog = console.log;
    
    console.log = function(...args) {
        const msg = args.join(' ');
        
        // Capture camp ID from cloud_storage_bridge log
        const match = msg.match(/Loading from cloud for camp:\s*([0-9a-f-]{36})/i);
        if (match) {
            const campId = match[1];
            window._cloudBridgeCampId = campId;
            window.CAMP_ID = campId;
            localStorage.setItem('camp_id', campId);
        }
        
        return originalLog.apply(console, args);
    };
    
    console.log._campIdPatched = true;
    
})();
