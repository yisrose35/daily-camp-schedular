// Copies the canonical Campistry Link parent-portal source files (which live
// at the repo root, alongside the rest of the no-build-step Campistry app)
// into this Capacitor project's www/ folder. Run via `npm run sync:www`
// (or `npm run sync`, which also runs `cap sync` afterward).
//
// There is exactly one source of truth for the app's HTML/CSS/JS — the repo
// root files. This script never edits them; it only copies.
'use strict';
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const WWW = path.resolve(__dirname, '..', 'www');

const FILES = [
    ['campistry_link_parent.html', 'index.html'],
    'campistry-unified.css',
    'campistry_link.css',
    'campistry_notes_quick.js',
    'campistry_link_capacitor.js',
    'campistry_ota.js',            // live-update bundle confirmation
    // Face matching, for the camper headshot + photo-consent flow. These were
    // missing from the bundle until the reference check below caught them.
    'face_match_core.js',
    'campistry_face_shared.js',
    'campistry_face_engine_v2.js',
    'supabase-js@2.js',
    'config.js',
    'campistry_link.webmanifest',
    'Campistry_logo.png',
    'Link_clean.png',
    'Link_apple_touch_icon.png',
];

// Same-repo references we deliberately do NOT bundle: pages belonging to the
// desktop admin app, which the native shell opens in the system browser.
const EXTERNAL_OK = new Set([
    'index.html',
    'dashboard.html',
    'campistry_notes.html',          // "Open in Notes →" — the desktop Notes app
    'campistry_link_admin.html',
    'campistry_link_staff.html',
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
// The native app BUNDLES these files — there is no server to 404 against, so a
// file that didn't get copied is a broken feature (or a white screen) on a real
// phone with nothing in a console to see. Three face-matching scripts shipped
// missing this way before this check existed.
const REF_RE = /['"]([A-Za-z0-9_@.\-]+\.(?:js|css|png|svg|webmanifest|html))['"]/g;
// Third-party bundles: nothing in them refers to a repo file, and their
// minified strings ("Node.js") trip the scan.
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
    console.error('\nA missing file in a bundled app is a broken feature on device, not a 404.');
    process.exitCode = 1;
} else if (!process.exitCode) {
    console.log('[sync-www] done — ' + FILES.length + ' files copied, bundle references all resolve.');
}
