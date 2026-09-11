// Vercel serverless function — live-update (OTA) endpoint for the Campistry
// mobile apps.
//
// The @capgo/capacitor-updater plugin in each app POSTs here on launch and asks
// "what's the newest web bundle?". We answer with the version and a download
// URL; the PLUGIN does the version comparison and the downloading, so this
// endpoint is deliberately stateless — it always reports the latest and never
// tries to decide whether a given device needs it.
//
// The manifests are plain JSON committed at ota/<app>.json and updated by the
// "Mobile — OTA release" workflow. So publishing an update is a git push, same
// as publishing a change to the website.
//
// Because these are require()'d, whatever they say is frozen into THIS
// function at Vercel's build time — a manifest commit does nothing here
// until Vercel actually rebuilds. The workflow's manifest-writeback commit
// carries [skip ci] (it never touches the web bundle a browser loads), and
// scripts/vercel-ignore-build.sh used to treat that as "safe to skip" —
// which meant this endpoint kept serving the OLD version forever, no
// matter how many times a device checked in. Fixed there: an ota/*.json
// change is now exempt from the [skip ci] skip.
//
// What this can and cannot ship:
//   CAN  — anything in the web bundle: HTML, CSS, JS, images.
//   CANNOT — native changes (plugins, permissions, app icon, native config).
//            Those still need a real App Store / Play Store release.

// Load each manifest defensively. The literal require() is what lets Vercel's
// file tracer bundle the JSON into this function, but if it ever throws at
// cold-start (a bad deploy, the file left out of the trace, a parse error in
// the deployed copy) an unguarded require at module scope takes the WHOLE
// function down with FUNCTION_INVOCATION_FAILED — which means every phone's
// launch-time update check hits a 500 and no device can ever learn a new
// bundle exists. So: try require, fall back to reading it off disk, and only
// then give up to null (reported cleanly as "nothing published"). A crashed
// update endpoint is far worse than one that briefly says "no update".
const fs = require('fs');
const path = require('path');
function loadManifest(app) {
    try {
        // Literal per-app require() so node-file-trace still bundles both files.
        return app === 'lite' ? require('../ota/lite.json') : require('../ota/link.json');
    } catch (_) { /* fall through to disk */ }
    try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'ota', app + '.json'), 'utf8'));
    } catch (e) {
        console.error('[ota] could not load ' + app + ' manifest:', (e && e.message) || e);
        return null;
    }
}
const MANIFESTS = {
    lite: loadManifest('lite'),
    link: loadManifest('link')
};

module.exports = async function handler(req, res) {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    // Never cache an update check: a stale "no new version" would pin devices
    // to an old bundle for the life of the CDN entry.
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }

    // Which app is asking. The plugin sends app_id in its POST body; ?app= is
    // there so you can check the endpoint from a browser.
    const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {});
    const appId = String(req.query?.app || body.app_id || '').toLowerCase();
    const key = appId.includes('link') ? 'link' : appId.includes('lite') ? 'lite' : '';

    if (!key) {
        res.status(400).json({ error: 'unknown_app', message: 'Expected app_id com.campistry.lite or com.campistry.link' });
        return;
    }

    const manifest = MANIFESTS[key];

    // A manifest with no bundle yet (fresh setup) is not an error — it means
    // "nothing published, keep running what shipped in the app".
    if (!manifest || !manifest.url) {
        res.status(200).json({ message: 'no_bundle_published' });
        return;
    }

    res.status(200).json({
        version: manifest.version,
        url: manifest.url,
        checksum: manifest.checksum || undefined
    });
  } catch (e) {
    // Never let the update endpoint 500 with an opaque crash — a readable
    // error is diagnosable AND keeps the plugin from treating it as a hard
    // failure it can't reason about.
    console.error('[ota] handler error:', e);
    try { res.status(500).json({ error: 'ota_handler_failed', message: String((e && e.message) || e) }); } catch (_) {}
  }
};

function safeParse(s) {
    try { return JSON.parse(s); } catch (_) { return {}; }
}
