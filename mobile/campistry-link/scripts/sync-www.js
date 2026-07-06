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
    'supabase-js@2.js',
    'config.js',
    'Campistry_logo.png',
    'Link_clean.png',
    'Link_apple_touch_icon.png',
];

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

if (!process.exitCode) {
    console.log('[sync-www] done — ' + FILES.length + ' files copied into ' + WWW);
}
