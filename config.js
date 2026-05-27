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
})();
