// node --test tests/bus_routes.test.js
// Validates the Campistry Go → print-sheet bridge:
//   • campers on a stop can be strings OR objects
//   • dismissal and arrival stay separate (a camper rides different buses)
//   • the active mode's top-level routes aren't double-counted
//   • name lookup tolerates case/spacing drift between Go and the roster
const test = require('node:test');
const assert = require('node:assert');
const B = require('../campistry_bus_routes.js');

const pmRoutes = [{
    shift: { label: 'First Bell' },
    routes: [{
        busId: 'b1', busName: 'Bus 3', busColor: '#10b981',
        monitor: { name: 'Rivky Gold' },
        counselors: [{ name: 'Sara Klein' }],
        stops: [
            { stopNum: 1, address: '13th Ave & 45th St', campers: ['Eli Katz', { name: 'Avi Stern' }] },
            { stopNum: 2, address: '16th Ave & 50th St', campers: [{ name: 'Moshe Blum' }] }
        ]
    }]
}];
const amRoutes = [{
    shift: { label: 'Morning' },
    routes: [{
        busId: 'b7', busName: 'Bus 7',
        stops: [{ stopNum: 4, address: 'Main & Elm', campers: ['Eli Katz'] }]
    }]
}];

test('collectMode: campers as plain strings and as objects both resolve', () => {
    const rows = B.collectMode(pmRoutes, 'dismissal');
    assert.strictEqual(rows.length, 3);
    assert.deepStrictEqual(rows.map(r => r.camperName), ['Eli Katz', 'Avi Stern', 'Moshe Blum']);
});

test('collectMode: bus, stop, shift, monitor and counselors all come through', () => {
    const eli = B.collectMode(pmRoutes, 'dismissal')[0];
    assert.strictEqual(eli.busName, 'Bus 3');
    assert.strictEqual(eli.stopNum, 1);
    assert.strictEqual(eli.address, '13th Ave & 45th St');
    assert.strictEqual(eli.shift, 'First Bell');
    assert.strictEqual(eli.monitor, 'Rivky Gold');
    assert.deepStrictEqual(eli.counselors, ['Sara Klein']);
    assert.strictEqual(eli.mode, 'dismissal');
});

test('collectMode: empty / malformed input yields no rows rather than throwing', () => {
    assert.deepStrictEqual(B.collectMode(null, 'dismissal'), []);
    assert.deepStrictEqual(B.collectMode([], 'dismissal'), []);
    assert.deepStrictEqual(B.collectMode([{}], 'dismissal'), []);
    assert.deepStrictEqual(B.collectMode([{ routes: [{ stops: [{ campers: [null, '', { }] }] }] }], 'x'), []);
});

test('collect: reads both modes from their own buckets', () => {
    const rows = B.collect({
        dismissal: { savedRoutes: pmRoutes },
        arrival: { savedRoutes: amRoutes }
    });
    assert.strictEqual(rows.length, 4);
    assert.strictEqual(rows.filter(r => r.mode === 'arrival').length, 1);
});

test('collect: the active mode is not double-counted from the top level', () => {
    // Go writes the live mode's routes BOTH at D.savedRoutes and under
    // D[mode].savedRoutes. Counting both would list every camper twice.
    const rows = B.collect({
        activeMode: 'dismissal',
        savedRoutes: pmRoutes,
        dismissal: { savedRoutes: pmRoutes }
    });
    assert.strictEqual(rows.length, 3);
});

test('collect: an older save with ONLY top-level routes is still read', () => {
    const rows = B.collect({ activeMode: 'dismissal', savedRoutes: pmRoutes });
    assert.strictEqual(rows.length, 3);
    assert.ok(rows.every(r => r.mode === 'dismissal'));
});

test('collect: no route data at all is an empty list', () => {
    assert.deepStrictEqual(B.collect({}), []);
    assert.deepStrictEqual(B.collect(null), []);
});

const GO = { dismissal: { savedRoutes: pmRoutes }, arrival: { savedRoutes: amRoutes } };

test('index keeps dismissal and arrival apart for the same camper', () => {
    // Eli rides Bus 3 home and Bus 7 in — collapsing these would be wrong.
    const idx = B.index(GO);
    assert.strictEqual(idx['Eli Katz'].dismissal.busName, 'Bus 3');
    assert.strictEqual(idx['Eli Katz'].arrival.busName, 'Bus 7');
    assert.strictEqual(idx['Moshe Blum'].arrival, undefined);
});

test('forCamper returns the row for the mode asked for, null when absent', () => {
    const idx = B.index(GO);
    assert.strictEqual(B.forCamper(idx, 'Eli Katz', 'arrival').stopNum, 4);
    assert.strictEqual(B.forCamper(idx, 'Moshe Blum', 'arrival'), null);
    assert.strictEqual(B.forCamper(idx, 'Nobody At All', 'dismissal'), null);
    assert.strictEqual(B.forCamper(idx, '', 'dismissal'), null);
    assert.strictEqual(B.forCamper(null, 'Eli Katz'), null);
});

test('forCamper defaults to dismissal', () => {
    assert.strictEqual(B.forCamper(B.index(GO), 'Eli Katz').busName, 'Bus 3');
});

test('forCamper tolerates case and spacing drift between Go and the roster', () => {
    // "no bus" for a double space would be a silently wrong print sheet.
    const idx = B.index(GO);
    assert.strictEqual(B.forCamper(idx, 'eli katz').busName, 'Bus 3');
    assert.strictEqual(B.forCamper(idx, 'Eli  Katz').busName, 'Bus 3');
    assert.strictEqual(B.forCamper(idx, '  Eli Katz  ').busName, 'Bus 3');
});

test('index keeps the first row when a camper is duplicated in one mode', () => {
    const dupe = [{ shift: {}, routes: [
        { busName: 'Bus 1', stops: [{ stopNum: 1, campers: ['Eli Katz'] }] },
        { busName: 'Bus 2', stops: [{ stopNum: 9, campers: ['Eli Katz'] }] }
    ] }];
    const idx = B.index({ dismissal: { savedRoutes: dupe } });
    assert.strictEqual(idx['Eli Katz'].dismissal.busName, 'Bus 1');
});

test('busNames lists buses naturally sorted, optionally per mode', () => {
    const many = [{ shift: {}, routes: [
        { busName: 'Bus 10', stops: [{ stopNum: 1, campers: ['A'] }] },
        { busName: 'Bus 2', stops: [{ stopNum: 1, campers: ['B'] }] }
    ] }];
    const go = { dismissal: { savedRoutes: many }, arrival: { savedRoutes: amRoutes } };
    assert.deepStrictEqual(B.busNames(go, 'dismissal'), ['Bus 2', 'Bus 10']);
    assert.deepStrictEqual(B.busNames(go, 'arrival'), ['Bus 7']);
    assert.deepStrictEqual(B.busNames(go), ['Bus 2', 'Bus 7', 'Bus 10']);
});

test('loadCloud resolves to null on error rather than rejecting', async () => {
    const failing = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({
        maybeSingle: () => Promise.resolve({ error: { message: 'nope' } }) }) }) }) }) };
    assert.strictEqual(await B.loadCloud(failing, 'camp1'), null);
    assert.strictEqual(await B.loadCloud(null, 'camp1'), null);
    assert.strictEqual(await B.loadCloud({}, null), null);
});

test('loadCloud maps the stored shape back to a Go-shaped blob', async () => {
    const client = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({
        maybeSingle: () => Promise.resolve({ data: { data: {
            activeMode: 'arrival', dismissalRoutes: pmRoutes, arrivalRoutes: amRoutes
        } } }) }) }) }) }) };
    const blob = await B.loadCloud(client, 'camp1');
    assert.strictEqual(blob.activeMode, 'arrival');
    assert.strictEqual(B.collect(blob).length, 4);
});
