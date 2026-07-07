/**
 * Tests for: detectLeagueTileTimeMismatch (scheduler_core_main.js)
 *
 * Regression: a grade playing in TWO leagues (e.g. a regular 4th–5th league
 * at 1:25–2:30 AND a separate "State Leagues" game at 5:10–6:30) must NOT be
 * flagged as a time mismatch for the first league — the second game window
 * belongs to a different league. Also: specialty-league tiles must never be
 * compared against regular leagues just because their name contains "league".
 *
 * Run with:  node --test tests/league_time_mismatch.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// =====================================================================
// MOCK ENVIRONMENT
// =====================================================================

let fakeStorage = {};
global.localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(fakeStorage, k) ? fakeStorage[k] : null; },
    setItem(k, v) { fakeStorage[k] = String(v); },
    removeItem(k) { delete fakeStorage[k]; }
};

global.document = {
    readyState: 'complete',
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
    createElement() { return { id: '', style: {}, classList: { add() {}, remove() {} }, appendChild() {}, addEventListener() {} }; },
    body: { appendChild() {} }
};

global.window = global;
global.addEventListener = function () {};
global.removeEventListener = function () {};

let _settings = {};
global.loadGlobalSettings = function () { return _settings; };

// Time parsing — the detector resolves these through SchedulerCoreUtils.
global.SchedulerCoreUtils = {
    parseTimeToMinutes(str) {
        if (typeof str === 'number') return str;
        if (!str) return null;
        const s = String(str).toLowerCase().trim();
        const m = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/);
        if (!m) return null;
        let h = parseInt(m[1], 10);
        const mm = parseInt(m[2], 10);
        if (m[3] === 'pm' && h !== 12) h += 12;
        if (m[3] === 'am' && h === 12) h = 0;
        return h * 60 + mm;
    },
    minutesToTimeLabel(mins) {
        const h = Math.floor(mins / 60), m = mins % 60, ap = h >= 12 ? 'PM' : 'AM', h12 = (h % 12) || 12;
        return h12 + ':' + String(m).padStart(2, '0') + ' ' + ap;
    }
};

require('../scheduler_core_main.js');

const detect = global._detectLeagueTileTimeMismatch;

function tile(division, type, leagueName, startTime, endTime) {
    return {
        id: 'evt_' + Math.random().toString(36).slice(2, 9),
        type,
        event: leagueName || 'League Game',
        leagueName: leagueName || undefined,
        division,
        startTime,
        endTime
    };
}

beforeEach(() => {
    fakeStorage = {};
    _settings = {};
    global.masterLeagues = undefined;
    global.leaguesByName = undefined;
});

describe('detectLeagueTileTimeMismatch', () => {
    it('exists on window', () => {
        assert.equal(typeof detect, 'function');
    });

    it('no warning when grades share identical league times', () => {
        global.leaguesByName = {
            'Junior League': { name: 'Junior League', enabled: true, divisions: ['4th Grade', '5th Grade'] }
        };
        const warnings = detect([
            tile('4th Grade', 'league', 'Junior League', '1:25pm', '2:30pm'),
            tile('5th Grade', 'league', 'Junior League', '1:25pm', '2:30pm')
        ]);
        assert.deepEqual(warnings, []);
    });

    it('warns when the same league has different times across grades', () => {
        global.leaguesByName = {
            'Junior League': { name: 'Junior League', enabled: true, divisions: ['4th Grade', '5th Grade'] }
        };
        const warnings = detect([
            tile('4th Grade', 'league', 'Junior League', '1:25pm', '2:30pm'),
            tile('5th Grade', 'league', 'Junior League', '1:30pm', '2:30pm')
        ]);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /Junior League/);
    });

    it("REGRESSION: a grade's second game in a DIFFERENT regular league is not a mismatch", () => {
        global.leaguesByName = {
            'Junior League': { name: 'Junior League', enabled: true, divisions: ['4th Grade', '5th Grade'] },
            'State Leagues': { name: 'State Leagues', enabled: true, divisions: ['5th Grade', '6th Grade'] }
        };
        const warnings = detect([
            tile('4th Grade', 'league', 'Junior League', '1:25pm', '2:30pm'),
            tile('5th Grade', 'league', 'Junior League', '1:25pm', '2:30pm'),
            tile('5th Grade', 'league', 'State Leagues', '5:10pm', '6:30pm')
        ]);
        assert.deepEqual(warnings, []);
    });

    it('REGRESSION: an UNNAMED second tile in a multi-league grade is ambiguous — no mismatch fabricated', () => {
        global.leaguesByName = {
            'Junior League': { name: 'Junior League', enabled: true, divisions: ['4th Grade', '5th Grade'] },
            'State Leagues': { name: 'State Leagues', enabled: true, divisions: ['5th Grade', '6th Grade'] }
        };
        const unnamed = tile('5th Grade', 'league', null, '5:10pm', '6:30pm');
        const warnings = detect([
            tile('4th Grade', 'league', 'Junior League', '1:25pm', '2:30pm'),
            tile('5th Grade', 'league', 'Junior League', '1:25pm', '2:30pm'),
            unnamed
        ]);
        assert.deepEqual(warnings, []);
    });

    it('unnamed tiles still count when the grade has exactly one league', () => {
        global.leaguesByName = {
            'Junior League': { name: 'Junior League', enabled: true, divisions: ['4th Grade', '5th Grade'] }
        };
        const warnings = detect([
            tile('4th Grade', 'league', null, '1:25pm', '2:30pm'),
            tile('5th Grade', 'league', null, '3:00pm', '4:00pm')
        ]);
        assert.equal(warnings.length, 1, 'genuine mismatch via unnamed auto-bound tiles still flags');
    });

    it('REGRESSION: specialty tiles are never compared against regular leagues', () => {
        global.leaguesByName = {
            'Junior League': { name: 'Junior League', enabled: true, divisions: ['4th Grade', '5th Grade'] }
        };
        _settings = {
            specialtyLeagues: {
                sl1: { name: 'State Leagues', enabled: true, divisions: ['5th Grade', '6th Grade'] }
            }
        };
        const warnings = detect([
            tile('4th Grade', 'league', 'Junior League', '1:25pm', '2:30pm'),
            tile('5th Grade', 'league', 'Junior League', '1:25pm', '2:30pm'),
            tile('5th Grade', 'specialty_league', 'State Leagues', '5:10pm', '6:30pm')
        ]);
        assert.deepEqual(warnings, []);
    });

    it('specialty leagues get their own mismatch check', () => {
        _settings = {
            specialtyLeagues: {
                sl1: { name: 'State Leagues', enabled: true, divisions: ['5th Grade', '6th Grade'] }
            }
        };
        const warnings = detect([
            tile('5th Grade', 'specialty_league', 'State Leagues', '5:10pm', '6:30pm'),
            tile('6th Grade', 'specialty_league', 'State Leagues', '5:15pm', '6:30pm')
        ]);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /State Leagues/);
    });

    it("REGRESSION: an extra non-overlapping game window in the SAME league is fine when a shared game exists", () => {
        // Even if the second tile carries the shared league's name (e.g. a
        // drag/copy auto-remapped it), a 5:10-6:30 window that collides with
        // nothing is an extra game — not a broken shared game.
        global.leaguesByName = {
            'Junior League': { name: 'Junior League', enabled: true, divisions: ['4th Grade', '5th Grade'] }
        };
        const warnings = detect([
            tile('4th Grade', 'league', 'Junior League', '1:25pm', '2:30pm'),
            tile('5th Grade', 'league', 'Junior League', '1:25pm', '2:30pm'),
            tile('5th Grade', 'league', 'Junior League', '5:10pm', '6:30pm')
        ]);
        assert.deepEqual(warnings, []);
    });

    it('still warns when windows overlap but are not identical', () => {
        global.leaguesByName = {
            'Junior League': { name: 'Junior League', enabled: true, divisions: ['4th Grade', '5th Grade'] }
        };
        const warnings = detect([
            tile('4th Grade', 'league', 'Junior League', '1:25pm', '2:30pm'),
            tile('5th Grade', 'league', 'Junior League', '1:25pm', '2:45pm')
        ]);
        assert.equal(warnings.length, 1, 'overlapping-but-unequal is a broken shared game');
    });

    it('still warns when grades share NO common game window', () => {
        global.leaguesByName = {
            'Junior League': { name: 'Junior League', enabled: true, divisions: ['4th Grade', '5th Grade'] }
        };
        const warnings = detect([
            tile('4th Grade', 'league', 'Junior League', '10:00am', '11:00am'),
            tile('5th Grade', 'league', 'Junior League', '3:00pm', '4:00pm')
        ]);
        assert.equal(warnings.length, 1, 'disjoint windows mean the grades never play together');
    });

    it('disabled leagues are ignored', () => {
        global.leaguesByName = {
            'Old League': { name: 'Old League', enabled: false, divisions: ['4th Grade', '5th Grade'] }
        };
        const warnings = detect([
            tile('4th Grade', 'league', 'Old League', '1:25pm', '2:30pm'),
            tile('5th Grade', 'league', 'Old League', '3:00pm', '4:00pm')
        ]);
        assert.deepEqual(warnings, []);
    });
});
