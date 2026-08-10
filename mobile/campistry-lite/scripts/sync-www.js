// Copies the canonical Campistry Lite source files (which live at the repo
// root, alongside the rest of the no-build-step Campistry app) into this
// Capacitor project's www/ folder. Run via `npm run sync:www` (or `npm run
// sync`, which also runs `cap sync` afterward).
//
// There is exactly one source of truth for the app's HTML/CSS/JS — the repo
// root files. This script never edits them; it only copies.
//
// Because the native app bundles these files (no network fallback), a missing
// file is a white screen on a real device rather than a 404 in a console. So
// after copying, this script scans the copied HTML/JS/CSS for references to
// same-repo assets and fails loudly on anything that didn't make it into www/.
'use strict';
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const WWW = path.resolve(__dirname, '..', 'www');

const FILES = [
    // Entry point. The login page is the correct boot screen: it resolves the
    // stored Supabase session (and the biometric app lock) and forwards to
    // campistry_lite.html when the user is already signed in.
    ['campistry_lite_login.html', 'index.html'],
    'campistry_lite_login.html',   // kept under its real name: campistry_lite.js
    'campistry_lite.html',         // and campistry_lite_login.js navigate by filename

    // Styles
    'campistry-unified.css',
    'campistry_lite.css',

    // Core stack, in the load order campistry_lite.html expects
    'config.js',
    'supabase-js@2.js',            // vendored SDK — native must never hit the CDN
    'supabase_client.js',
    'access_control.js',
    'supabase_permissions.js',
    'supabase_schedules.js',
    'division_times_system.js',
    'rotation_cloud.js',
    'campistry_visibility.js',
    'campistry_lite_biometric.js',
    'campistry_lite.js',
    'campistry_lite_login.js',
    'campistry_lite_capacitor.js', // native glue; a no-op on the web
    'campistry_ota.js',            // live-update bundle confirmation

    'manifest_lite.webmanifest',

    // Brand art + the product tiles on the home launcher
    'Campistry_logo.png',
    'Lite_clean.png',
    'Flow_clean.png',
    'Me_clean.png',
    'Live_clean.png',
    'Health_clean.png',
    'Link_clean.png',
    'Notes_clean.png',
    'Go_clean.png',
];

// Same-repo references we deliberately do NOT bundle: pages that belong to the
// full desktop site. The native shell opens these in the system browser.
const EXTERNAL_OK = new Set([
    'dashboard.html',
    'index.html',
    'flow.html',
    'campistry_me.html',
    'campistry_link_parent.html',
]);

fs.rmSync(WWW, { recursive: true, force: true });
fs.mkdirSync(WWW, { recursive: true });

for (const entry of FILES) {
    const [src, dest] = Array.isArray(entry) ? entry : [entry, entry];
    const srcPath = path.join(REPO_ROOT, src);
    const destPath = path.join(WWW, dest);
    if (!fs.existsSync(srcPath)) {
        console.error('[sync-www] MISSING source file: ' + src);
        process.exitCode = 1;
        continue;
    }
    fs.copyFileSync(srcPath, destPath);
    console.log('[sync-www] ' + src + ' -> www/' + dest);
}

// ── Bundle-completeness check ────────────────────────────────────────────────
const REF_RE = /['"]([A-Za-z0-9_@.\-]+\.(?:js|css|png|svg|webmanifest|html))['"]/g;
// Third-party bundles: nothing in them refers to a repo file, and their
// minified strings ("Node.js") trip the reference scan.
const SKIP_SCAN = new Set(['supabase-js@2.js']);
const missing = new Map();
for (const name of fs.readdirSync(WWW)) {
    if (!/\.(html|js|css)$/i.test(name)) continue;
    if (SKIP_SCAN.has(name)) continue;
    const body = fs.readFileSync(path.join(WWW, name), 'utf8');
    let m;
    while ((m = REF_RE.exec(body)) !== null) {
        const ref = m[1];
        if (EXTERNAL_OK.has(ref)) continue;
        if (fs.existsSync(path.join(WWW, ref))) continue;
        if (!missing.has(ref)) missing.set(ref, new Set());
        missing.get(ref).add(name);
    }
}
if (missing.size) {
    console.error('\n[sync-www] BUNDLE INCOMPLETE — these files are referenced but not in www/:');
    for (const [ref, from] of missing) {
        const inRepo = fs.existsSync(path.join(REPO_ROOT, ref));
        console.error('  ' + ref + '  (referenced by ' + [...from].join(', ') + ')'
            + (inRepo ? '  <- exists at repo root: add it to FILES' : '  <- NOT in the repo either'));
    }
    console.error('\nA missing file in a bundled app is a white screen on device, not a 404.');
    process.exitCode = 1;
} else if (!process.exitCode) {
    console.log('[sync-www] done — ' + FILES.length + ' files copied, bundle references all resolve.');
}
