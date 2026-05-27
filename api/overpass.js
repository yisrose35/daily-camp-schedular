// Vercel serverless function — Overpass API proxy.
// Bypasses browser CORS restrictions and adds the User-Agent that Overpass
// requires. Forwards the `data` query param to one of three Overpass mirrors
// and returns the JSON response.

const MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
];

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }

    const query = req.query?.data;
    if (!query) { res.status(400).json({ error: 'missing data param' }); return; }

    for (const mirror of MIRRORS) {
        try {
            const url = mirror + '?data=' + encodeURIComponent(query);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 20000);
            const upstream = await fetch(url, {
                method: 'GET',
                headers: {
                    'User-Agent': 'Campistry/1.0 (camp routing tool)',
                    'Accept': 'application/json'
                },
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (upstream.status === 504 || upstream.status === 429 || upstream.status === 503) continue;
            if (!upstream.ok) continue;
            const data = await upstream.json();
            res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
            res.status(200).json(data);
            return;
        } catch (e) {
            continue;
        }
    }
    res.status(502).json({ error: 'all overpass mirrors failed' });
};
