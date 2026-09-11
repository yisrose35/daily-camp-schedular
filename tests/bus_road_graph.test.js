// node --test tests/bus_road_graph.test.js
//
// The road graph download is tiled and cached per tile; intersections for
// corner stops come from the graph. Pure helpers, no network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

global.window = global.window || {};
eval(fs.readFileSync(path.join(__dirname, '..', 'campistry_go_route_post.js'), 'utf8'));
eval(fs.readFileSync(path.join(__dirname, '..', 'campistry_go_neighborhoods.js'), 'utf8'));
const NH = global.window.CampistryGoNeighborhoods;
const { tilesFor, mergeTiles } = NH._internal;

test('tilesFor covers the bbox with a stable grid, so a roster change reuses the same tiles', () => {
    const a = tilesFor(40.02, -74.35, 40.21, -74.05);
    assert.ok(a.length >= 6 && a.length <= 12, 'a camp-sized area is a handful of tiles, got ' + a.length);
    for (const t of a) {
        assert.ok(t.bbox[0] <= 40.21 && t.bbox[2] >= 40.02 && t.bbox[1] <= -74.05 && t.bbox[3] >= -74.35, 'tile overlaps the bbox');
        assert.match(t.key, /^tile:v1:-?\d+:-?\d+$/);
    }
    // a slightly different bbox (one camper moved) shares most keys
    const b = tilesFor(40.03, -74.34, 40.22, -74.04);
    const shared = a.filter(t => b.some(u => u.key === t.key)).length;
    assert.ok(shared >= a.length - 4, 'tiles are reused: ' + shared + ' of ' + a.length);
});

test('mergeTiles keeps every node and way once even when tiles overlap on them', () => {
    const t1 = { elements: [{ type: 'node', id: 1, lat: 40, lon: -74 }, { type: 'node', id: 2, lat: 40.1, lon: -74 }, { type: 'way', id: 9, nodes: [1, 2], tags: { highway: 'residential', name: 'Elm St' } }] };
    const t2 = { elements: [{ type: 'node', id: 2, lat: 40.1, lon: -74 }, { type: 'node', id: 3, lat: 40.2, lon: -74 }, { type: 'way', id: 9, nodes: [1, 2], tags: { highway: 'residential', name: 'Elm St' } }, { type: 'way', id: 10, nodes: [2, 3], tags: { highway: 'primary', name: 'Main St' } }] };
    const m = mergeTiles([t1, t2, null]);
    assert.strictEqual(m.elements.filter(e => e.type === 'node').length, 3);
    assert.strictEqual(m.elements.filter(e => e.type === 'way').length, 2);
});

test('intersectionsFromGraph names corners where two streets meet and lists major-road segments', () => {
    const g = { elements: [
        { type: 'node', id: 1, lat: 40.0, lon: -74.0 }, { type: 'node', id: 2, lat: 40.0, lon: -74.01 }, { type: 'node', id: 3, lat: 40.01, lon: -74.01 },
        { type: 'way', id: 9, nodes: [1, 2], tags: { highway: 'residential', name: 'Elm St' } },
        { type: 'way', id: 10, nodes: [2, 3], tags: { highway: 'secondary', name: 'Main St' } },
    ] };
    const d = NH.intersectionsFromGraph(g);
    assert.strictEqual(d.intersections.length, 1, 'one corner');
    assert.strictEqual(d.intersections[0].name, 'Elm St & Main St');
    assert.deepStrictEqual(d.intersections[0].streets, ['Elm St', 'Main St']);
    assert.strictEqual(d.majorSegments.length, 1, 'the secondary road is a major segment');
    assert.strictEqual(d.majorSegments[0].name, 'Main St');
});

test('a no-network run returns no graph without touching the network; sandbox alone does not block it', async () => {
    let fetched = 0;
    global.fetch = async () => { fetched++; throw new Error('offline'); };
    global.window.CampistryGoSandbox = { isSandbox: () => true, noNetwork: () => true };
    const campers = Array.from({ length: 10 }, (_, i) => ({ lat: 40.09 + i * 0.001, lng: -74.21 + i * 0.001 }));
    assert.strictEqual(await NH.loadRoadGraph(campers, {}), null);
    assert.strictEqual(fetched, 0, 'no request when the no-network flag is set');
    // sandbox on, network allowed: the download is attempted (and fails offline here)
    global.window.CampistryGoSandbox = { isSandbox: () => true, noNetwork: () => false };
    global.indexedDB = undefined;
    const r = await NH.loadRoadGraph(campers, {});
    assert.strictEqual(r, null);
    assert.ok(fetched > 0, 'sandbox mode no longer prevents the free map download');
});
