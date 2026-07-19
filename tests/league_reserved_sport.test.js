/**
 * Tests for Utils.isSportReservedForLeague — the standing "Reserve for League
 * Play" rule. A league (regular or specialty) with reserveSportForLeague=true
 * keeps its sport(s) out of REGULAR play for its divisions; league game
 * placement is unaffected (it never consults this gate — regular-league fit
 * checks pass actName "League Game").
 *
 *   - regular leagues:  window.leaguesByName[name] = { divisions:[], sports:[], reserveSportForLeague }
 *   - specialty leagues: window.specialtyLeagues[id] = { divisions:[], sport, reserveSportForLeague }
 *   - falls back to loadGlobalSettings().leaguesByName / .specialtyLeagues
 *   - matching is case-insensitive on division and sport; fail-open otherwise
 *
 * Run with: node --test tests/league_reserved_sport.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function bootUtils() {
    const sandbox = {
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
        setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
        Date, Math, Object, Array, JSON, String, Number, Boolean, RegExp, Error,
        Map, Set, WeakMap, WeakSet, Promise, parseInt, parseFloat, isNaN, isFinite,
        Infinity, NaN, Symbol, encodeURIComponent, decodeURIComponent,
    };
    sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox; sandbox.global = sandbox;
    const makeEl = () => ({ appendChild() {}, addEventListener() {}, setAttribute() {}, style: {}, children: [], dataset: {} });
    sandbox.document = {
        readyState: 'complete', createElement: makeEl, createDocumentFragment: makeEl,
        getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; },
        addEventListener() {}, removeEventListener() {}, body: makeEl(), head: makeEl(),
    };
    sandbox.localStorage = (() => { let s = {}; return { getItem(k) { return Object.prototype.hasOwnProperty.call(s, k) ? s[k] : null; }, setItem(k, v) { s[k] = String(v); }, removeItem(k) { delete s[k]; }, clear() { s = {}; } }; })();
    sandbox.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
    sandbox.dispatchEvent = () => true; sandbox.addEventListener = () => {}; sandbox.removeEventListener = () => {};
    sandbox.requestAnimationFrame = () => 0; sandbox.cancelAnimationFrame = () => {};
    sandbox.location = { href: '', reload() {}, search: '' };
    sandbox.navigator = { onLine: true, userAgent: 'node' };
    sandbox.AccessControl = null;
    sandbox.currentScheduleDate = '2026-07-15';
    sandbox.loadCurrentDailyData = () => ({});
    sandbox.getLocationForActivity = () => null;

    const code = fs.readFileSync(path.join(__dirname, '..', 'scheduler_core_utils.js'), 'utf8');
    vm.runInNewContext(code, sandbox, { filename: 'scheduler_core_utils.js' });
    return sandbox;
}

const VOLLEY_LEAGUE = {
    name: '7th Grade Volleyball',
    divisions: ['7th Grade'],
    sports: ['Volleyball'],
    reserveSportForLeague: true,
    enabled: true
};

describe('isSportReservedForLeague (standing league-reservation rule)', () => {
    let win, U;
    beforeEach(() => { win = bootUtils(); U = win.SchedulerCoreUtils; });

    it('no leagues configured → nothing reserved', () => {
        assert.strictEqual(U.isSportReservedForLeague('7th Grade', 'Volleyball'), false);
    });

    it('reserved sport is blocked for the league division only', () => {
        win.leaguesByName = { '7th Grade Volleyball': VOLLEY_LEAGUE };
        assert.strictEqual(U.isSportReservedForLeague('7th Grade', 'Volleyball'), true);
        assert.strictEqual(U.isSportReservedForLeague('6th Grade', 'Volleyball'), false); // other division unaffected
        assert.strictEqual(U.isSportReservedForLeague('7th Grade', 'Basketball'), false); // other sport unaffected
    });

    it('toggle off (or missing) → not reserved', () => {
        win.leaguesByName = { L: { ...VOLLEY_LEAGUE, reserveSportForLeague: false } };
        assert.strictEqual(U.isSportReservedForLeague('7th Grade', 'Volleyball'), false);
        win.leaguesByName = { L: { divisions: ['7th Grade'], sports: ['Volleyball'] } };
        assert.strictEqual(U.isSportReservedForLeague('7th Grade', 'Volleyball'), false);
    });

    it('disabled league does not reserve its sport', () => {
        win.leaguesByName = { L: { ...VOLLEY_LEAGUE, enabled: false } };
        assert.strictEqual(U.isSportReservedForLeague('7th Grade', 'Volleyball'), false);
    });

    it('matching is case/whitespace-insensitive', () => {
        win.leaguesByName = { L: VOLLEY_LEAGUE };
        assert.strictEqual(U.isSportReservedForLeague(' 7TH GRADE ', 'volleyball'), true);
    });

    it('specialty league (singular sport field) reserves too', () => {
        win.specialtyLeagues = { sl1: { name: 'VB', divisions: ['7th Grade'], sport: 'Volleyball', reserveSportForLeague: true, enabled: true } };
        assert.strictEqual(U.isSportReservedForLeague('7th Grade', 'Volleyball'), true);
        assert.strictEqual(U.isSportReservedForLeague('8th Grade', 'Volleyball'), false);
    });

    it('falls back to loadGlobalSettings when window registries are empty', () => {
        win.loadGlobalSettings = () => ({ leaguesByName: { L: VOLLEY_LEAGUE } });
        assert.strictEqual(U.isSportReservedForLeague('7th Grade', 'Volleyball'), true);
    });

    it('fail-open: missing args are never reserved', () => {
        win.leaguesByName = { L: VOLLEY_LEAGUE };
        assert.strictEqual(U.isSportReservedForLeague(null, 'Volleyball'), false);
        assert.strictEqual(U.isSportReservedForLeague('7th Grade', null), false);
    });
});

describe('canBlockFit honors the league-reserved sport rule', () => {
    let win, U, activityProperties;
    beforeEach(() => {
        win = bootUtils();
        U = win.SchedulerCoreUtils;
        win.leaguesByName = { '7th Grade Volleyball': VOLLEY_LEAGUE };
        activityProperties = { 'Volleyball Court': {
            available: true, sharable: true,
            sharableWith: { capacity: 99, type: 'all', divisions: [] },
            timeRules: [], transition: { preMin: 0, postMin: 0, zone: 'default', occupiesField: false }
        } };
        win.fieldUsageBySlot = {};
    });
    const mk = (divName, bunk) => ({ bunk, divName, startTime: 600, endTime: 660, slots: [600] });

    it('rejects the reserved sport as a regular activity for the league division', () => {
        assert.strictEqual(U.canBlockFit(mk('7th Grade', 'Bunk 7A'), 'Volleyball Court', activityProperties, {}, 'Volleyball'), false);
    });

    it('other divisions may still play the sport in regular slots', () => {
        assert.strictEqual(U.canBlockFit(mk('6th Grade', 'Bunk 6A'), 'Volleyball Court', activityProperties, {}, 'Volleyball'), true);
    });

    it('league game placement is NOT blocked (actName "League Game" + forceLeague)', () => {
        assert.strictEqual(U.canBlockFit(mk('7th Grade', 'Bunk 7A'), 'Volleyball Court', activityProperties, {}, 'League Game', true), true);
    });
});
