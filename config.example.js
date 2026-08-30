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

    // Your Stripe PUBLISHABLE key (pk_live_... or pk_test_...) — safe to ship
    // to the browser, same as the anon key above. One value for the whole
    // platform, set once here — never per camp. The matching SECRET key
    // (sk_...) goes only in Supabase → Edge Functions → Secrets as
    // STRIPE_SECRET_KEY, also set once, never touched by camp owners.
    window.__CAMPISTRY_STRIPE__ = {
        publishableKey: 'YOUR_STRIPE_PUBLISHABLE_KEY'
    };
})();
