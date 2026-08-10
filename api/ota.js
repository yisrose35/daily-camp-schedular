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
// What this can and cannot ship:
//   CAN  — anything in the web bundle: HTML, CSS, JS, images.
//   CANNOT — native changes (plugins, permissions, app icon, native config).
//            Those still need a real App Store / Play Store release.

const MANIFESTS = {
    lite: require('../ota/lite.json'),
    link: require('../ota/link.json')
};

module.exports = async function handler(req, res) {
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
};

function safeParse(s) {
    try { return JSON.parse(s); } catch (_) { return {}; }
}
