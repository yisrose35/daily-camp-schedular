/**
 * Tests for travel-time feature.
 *
 * Covers:
 *   - window.getTravelForField(field, manualMode) — zone lookup, deduct/extend mode
 *   - window.getTravelForSpecialActivity(name, manualMode)
 *   - window.seamMergeTravelTime(assignments) — drops middle travel between same-zone blocks
 *
 * Run with: node --test tests/travel_time.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert'); // non-strict: deepEqual ignores prototype (vm context boundary)
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ---------------------------------------------------------------------------
// SANDBOX — mimic the minimum browser globals zones.js needs at load time
// ---------------------------------------------------------------------------
function freshSandbox(zonesData = {}) {
    const sandbox = {
        console,
        // DOM stubs — zones.js's IIFE references document, but the tab init
        // only runs when initZonesTab() is explicitly called. The helpers at
        // the bottom (window.getTravelForField etc.) are registered at load.
        document: {
            readyState: 'complete',
            getElementById() { return null; },
            addEventListener() {},
            createElement() {
                return {
                    id: '', style: {}, innerHTML: '', textContent: '',
                    appendChild() {}, querySelector() { return null; },
                    closest() { return null; }, setAttribute() {}
                };
            },
            body: { appendChild() {} }
        },
        setTimeout: (fn) => fn(),
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;

    // The helpers read zones via window.loadGlobalSettings().locationZones
    sandbox.loadGlobalSettings = () => ({ locationZones: zonesData });
    sandbox.saveLocationZones = () => {};
    sandbox.savePinnedTileDefaults = () => {};
    sandbox.getFacilities = () => [];
    sandbox.getAllSpecialActivities = () => [];

    return sandbox;
}

function loadZones(sandbox) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'zones.js'), 'utf8');
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'zones.js' });
}

// ---------------------------------------------------------------------------
// FIXTURES
// ---------------------------------------------------------------------------
function zones() {
    return {
        'Main Campus': {
            name: 'Main Campus', isDefault: true, isOffCampus: false,
            travelTimeMin: 0, travelMode: 'deduct',
            transition: { preMin: 0, postMin: 0 },
            maxConcurrent: 99, fields: ['Main Field'], specialActivities: [], locations: {}
        },
        'School #2': {
            name: 'School #2', isDefault: false, isOffCampus: true,
            travelTimeMin: 5, travelMode: 'deduct',
            transition: { preMin: 0, postMin: 0 },
            maxConcurrent: 99,
            fields: ['#2 Baseball Field'], specialActivities: ['Off-site Art'], locations: {}
        },
        'Far Park': {
            name: 'Far Park', isDefault: false, isOffCampus: true,
            travelTimeMin: 10, travelMode: 'extend',
            transition: { preMin: 0, postMin: 0 },
            maxConcurrent: 99,
            fields: ['Far Park Field'], specialActivities: [], locations: {}
        },
        'Zero-travel Off': {
            name: 'Zero-travel Off', isDefault: false, isOffCampus: true,
            travelTimeMin: 0, travelMode: 'deduct',
            transition: { preMin: 0, postMin: 0 },
            maxConcurrent: 99, fields: ['Ghost Field'], specialActivities: [], locations: {}
        }
    };
}

// ---------------------------------------------------------------------------
// TESTS — getTravelForField
// ---------------------------------------------------------------------------
describe('getTravelForField', () => {
    let sb;
    beforeEach(() => {
        sb = freshSandbox(zones());
        loadZones(sb);
    });

    it('returns null for on-campus field', () => {
        assert.equal(sb.getTravelForField('Main Field'), null);
    });

    it('returns null for unknown field', () => {
        assert.equal(sb.getTravelForField('Does Not Exist'), null);
    });

    it('returns null for off-campus field when travelTimeMin is 0', () => {
        assert.equal(sb.getTravelForField('Ghost Field'), null);
    });

    it('returns deduct-mode travel for off-campus field', () => {
        const t = sb.getTravelForField('#2 Baseball Field');
        assert.deepEqual(t, { preMin: 5, postMin: 5, mode: 'deduct', zoneName: 'School #2' });
    });

    it('returns extend-mode travel when zone is set to extend', () => {
        const t = sb.getTravelForField('Far Park Field');
        assert.deepEqual(t, { preMin: 10, postMin: 10, mode: 'extend', zoneName: 'Far Park' });
    });

    it('forces deduct mode when manualMode=true (overrides extend zone)', () => {
        const t = sb.getTravelForField('Far Park Field', true);
        assert.equal(t.mode, 'deduct', 'manual edits always deduct');
        assert.equal(t.preMin, 10);
        assert.equal(t.postMin, 10);
    });

    it('returns null for null / empty input', () => {
        assert.equal(sb.getTravelForField(null), null);
        assert.equal(sb.getTravelForField(''), null);
    });
});

// ---------------------------------------------------------------------------
// TESTS — getTravelForSpecialActivity
// ---------------------------------------------------------------------------
describe('getTravelForSpecialActivity', () => {
    let sb;
    beforeEach(() => {
        sb = freshSandbox(zones());
        loadZones(sb);
    });

    it('returns travel info for off-campus special activity', () => {
        const t = sb.getTravelForSpecialActivity('Off-site Art');
        assert.deepEqual(t, { preMin: 5, postMin: 5, mode: 'deduct', zoneName: 'School #2' });
    });

    it('returns null for unknown special', () => {
        assert.equal(sb.getTravelForSpecialActivity('Unknown'), null);
    });
});

// ---------------------------------------------------------------------------
// TESTS — seamMergeTravelTime
// ---------------------------------------------------------------------------
describe('seamMergeTravelTime', () => {
    let sb;
    beforeEach(() => {
        sb = freshSandbox(zones());
        loadZones(sb);
    });

    // Helper to build a block quickly
    const blk = (startMin, endMin, opts) => Object.assign({
        startMin, endMin,
        _travelPre: 5, _travelPost: 5,
        _travelZone: 'School #2'
    }, opts || {});

    it('clears middle travel between two back-to-back same-zone blocks', () => {
        const assignments = {
            'Bunk A': [ blk(600, 660), blk(660, 720) ]
        };
        const cleared = sb.seamMergeTravelTime(assignments);
        assert.equal(cleared, 2);
        assert.equal(assignments['Bunk A'][0]._travelPost, 0, 'earlier block post cleared');
        assert.equal(assignments['Bunk A'][1]._travelPre,  0, 'later block pre cleared');
        // Outer edges preserved
        assert.equal(assignments['Bunk A'][0]._travelPre,  5);
        assert.equal(assignments['Bunk A'][1]._travelPost, 5);
    });

    it('does NOT clear when zones differ', () => {
        const assignments = {
            'Bunk A': [
                blk(600, 660, { _travelZone: 'School #2' }),
                blk(660, 720, { _travelZone: 'Far Park' })
            ]
        };
        sb.seamMergeTravelTime(assignments);
        assert.equal(assignments['Bunk A'][0]._travelPost, 5);
        assert.equal(assignments['Bunk A'][1]._travelPre,  5);
    });

    it('does NOT clear when gap between blocks exceeds 5 min', () => {
        const assignments = {
            'Bunk A': [ blk(600, 660), blk(680, 740) ] // 20-min gap
        };
        sb.seamMergeTravelTime(assignments);
        assert.equal(assignments['Bunk A'][0]._travelPost, 5);
        assert.equal(assignments['Bunk A'][1]._travelPre,  5);
    });

    it('DOES clear when there is a small (<=5 min) gap', () => {
        const assignments = {
            'Bunk A': [ blk(600, 660), blk(665, 725) ]
        };
        sb.seamMergeTravelTime(assignments);
        assert.equal(assignments['Bunk A'][0]._travelPost, 0);
        assert.equal(assignments['Bunk A'][1]._travelPre,  0);
    });

    it('ignores blocks without _travelZone', () => {
        const assignments = {
            'Bunk A': [
                { startMin: 600, endMin: 660 }, // no travel
                blk(660, 720)
            ]
        };
        const cleared = sb.seamMergeTravelTime(assignments);
        assert.equal(cleared, 0);
        assert.equal(assignments['Bunk A'][1]._travelPre, 5);
    });

    it('handles three consecutive same-zone blocks correctly', () => {
        const assignments = {
            'Bunk A': [ blk(600, 660), blk(660, 720), blk(720, 780) ]
        };
        sb.seamMergeTravelTime(assignments);
        const [a, b, c] = assignments['Bunk A'];
        assert.equal(a._travelPre,  5, 'first block pre preserved (outer edge)');
        assert.equal(a._travelPost, 0, 'a-b seam cleared');
        assert.equal(b._travelPre,  0, 'a-b seam cleared');
        assert.equal(b._travelPost, 0, 'b-c seam cleared');
        assert.equal(c._travelPre,  0, 'b-c seam cleared');
        assert.equal(c._travelPost, 5, 'last block post preserved (outer edge)');
    });

    it('operates per-bunk (different bunks do not affect each other)', () => {
        const assignments = {
            'Bunk A': [ blk(600, 660), blk(660, 720) ],
            'Bunk B': [ blk(600, 660) ]
        };
        sb.seamMergeTravelTime(assignments);
        assert.equal(assignments['Bunk A'][0]._travelPost, 0);
        assert.equal(assignments['Bunk B'][0]._travelPost, 5, 'single-block bunk untouched');
    });

    it('is a no-op on empty/null input', () => {
        assert.equal(sb.seamMergeTravelTime(null), 0);
        assert.equal(sb.seamMergeTravelTime({}), 0);
        assert.equal(sb.seamMergeTravelTime({ 'Bunk A': [] }), 0);
    });
});
