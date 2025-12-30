// ============================================================================
// supabase_client.js — Supabase Client Initialization
// ============================================================================

const SUPABASE_URL = "https://bzqmhcumuarrbueqttfh.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ6cW1oY3VtdWFycmJ1ZXF0dGZoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NDg3NDAsImV4cCI6MjA4MjEyNDc0MH0.5WpFBj1s1937XNZ0yxLdlBWO7xolPtf7oB10LDLONsI";
window.supabase = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
