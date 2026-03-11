// =============================================================================
// Campistry Supabase config (example — copy to config.js and fill in)
// =============================================================================
// Copy this file to config.js and set your Supabase URL and anon key.
// Add config.js to .gitignore so the real key is never committed.
// Load config.js before supabase_client.js on every page that uses Supabase.
// =============================================================================

(function() {
    'use strict';
    window.__CAMPISTRY_SUPABASE__ = {
        url: 'https://your-project.supabase.co',
        anonKey: 'YOUR_SUPABASE_ANON_KEY'
    };
})();
