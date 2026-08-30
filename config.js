// =============================================================================
// Campistry Supabase config — anon key + project URL.
//
// The anon key is designed to be public; it is shipped to every browser
// that loads this app, and Supabase RLS is the actual authorization
// boundary. So this file is intentionally checked into the repo.
//
// DO NOT add the service_role key, JWT secret, or any other privileged
// credential to this file — those keys bypass RLS entirely and would
// be a critical leak. Service-role access belongs server-side (Edge
// Functions / dedicated backend), never in client code.
// =============================================================================

(function() {
    'use strict';
    window.__CAMPISTRY_SUPABASE__ = {
        url: 'https://bzqmhcumuarrbueqttfh.supabase.co',
        anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ6cW1oY3VtdWFycmJ1ZXF0dGZoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NDg3NDAsImV4cCI6MjA4MjEyNDc0MH0.5WpFBj1s1937XNZ0yxLdlBWO7xolPtf7oB10LDLONsI'
    };

    // Public base URL of the Campistry Link PARENT portal. Set this once the
    // parent portal lives on its own domain/subdomain (e.g.
    // 'https://link.yourcamp.com') so every invite link + the announcement
    // email points THERE instead of the admin's origin. Trailing slash optional.
    // Empty string = same origin as the page generating the link (default).
    window.__CAMPISTRY_PARENT_URL__ = 'https://link.campistry.org';

    // Campistry's own Stripe PUBLISHABLE key (pk_live_... / pk_test_...) — one
    // value, platform-wide, same as the anon key above: designed to be public,
    // safe to ship to every browser. This is NOT a per-camp setting — every
    // card Stripe.js collects (save-a-card, tuition checkout, installments)
    // is issued as a SetupIntent/PaymentIntent on THIS platform Stripe account
    // server-side (via the STRIPE_SECRET_KEY Edge Function secret, set once in
    // the Supabase dashboard — never here, never in any browser-facing file).
    // Which camp's bank account the resulting money lands in is handled
    // separately, per camp, via Stripe Connect (Dashboard → Payment
    // Processing → "Where tuition money lands") — camp owners never touch
    // Supabase or this file at all.
    // TODO: replace with your real publishable key from
    // https://dashboard.stripe.com/apikeys before card collection will work.
    window.__CAMPISTRY_STRIPE__ = {
        publishableKey: ''
    };
})();
