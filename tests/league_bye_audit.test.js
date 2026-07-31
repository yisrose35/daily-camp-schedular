// =============================================================================
// league_bye_audit.test.js
// -----------------------------------------------------------------------------
// window.byeAudit() — the console report that answers "is the bye landing on a
// different team each time?" after a run of days. build() takes injected
// history + dailyData, so the aggregation is exercised here without a DOM.
// =============================================================================

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const A = require('../league_bye_audit.js');

const LG = 'Soloists';
const TEAMS = ['T1', 'T2', 'T3', 'T4', 'T5'];

// ── builders for the two stores the audit reads ──────────────────────────────

// One saved league period: the tile's matchups array, exactly as the engine
// writes it, keyed the way daily data keys it (date → division → slot).
function period(label, games, byes, chinuch) {
    const matchups = [];
    (games || []).forEach(g => matchups.push(g[0] + ' vs ' + g[1] + ' @ Court 1 (Basketball)'));
    (byes || []).forEach(b => matchups.push(Array.isArray(b) ? (b[0] + ' — Bye: ' + b[1]) : (b + ' — Bye')));
    (chinuch || []).forEach(c => matchups.push(c[0] + ' — Chinuch (' + c[1] + ')'));
    return { leagueName: LG, gameLabel: label, matchups };
}
function dailyData(spec) {
    // spec: { date: [periodObj, …] }
    const out = {};
    Object.keys(spec).forEach(date => {
        const la = { Juniors: {} };
        spec[date].forEach((p, i) => { la.Juniors[String(780 + i * 60)] = p; });
        out[date] = { leagueAssignments: la };
    });
    return out;
}
// The engine's ledger for the same days, so the drift check is satisfied.
function historyFor(spec, chinuchByDate) {
    const gameLog = { [LG]: {} };
    Object.keys(spec).forEach(date => {
        gameLog[LG][date] = [];
        spec[date].forEach(p => {
            (p.matchups || []).forEach(m => {
                const g = /^(.+?) vs (.+?) @/.exec(m);
                if (g) gameLog[LG][date].push({ t1: g[1], t2: g[2], sport: 'Basketball', g: p.gameLabel });
            });
        });
    });
    return { gameLog, chinuchByDate: chinuchByDate ? { [LG]: chinuchByDate } : {} };
}
function run(spec, leagueCfg, chinuchByDate, opts) {
    const dd = dailyData(spec);
    return A.build(Object.assign({
        history: historyFor(spec, chinuchByDate),
        dailyData: dd,
        leagues: [Object.assign({ name: LG, teams: TEAMS.slice() }, leagueCfg || {})],
    }, opts || {})).leagues[0];
}
const codes = (L) => L.findings.map(f => f.code);
const find = (L, code) => L.findings.find(f => f.code === code);

// ── line parsing ─────────────────────────────────────────────────────────────

test('parseLine reads each tile line shape the engine writes', () => {
    assert.deepEqual(A.parseLine('T5 — Bye'), { kind: 'bye', team: 'T5', activity: '' });
    assert.deepEqual(A.parseLine('T5 — Bye: Pool'), { kind: 'bye', team: 'T5', activity: 'Pool' });
    assert.deepEqual(A.parseLine('T1 — Chinuch (Beis Medrash)'),
        { kind: 'chinuch', team: 'T1', room: 'Beis Medrash' });
    assert.deepEqual(A.parseLine('T1 vs T2 @ Court 1 (Basketball)'),
        { kind: 'game', teamA: 'T1', teamB: 'T2' });
    // A team whose NAME contains "vs" or a dash must not be mangled.
    assert.deepEqual(A.parseLine('Red-Sox — Bye: Canteen'),
        { kind: 'bye', team: 'Red-Sox', activity: 'Canteen' });
    // Section rows and noise are ignored.
    assert.equal(A.parseLine('Electives:'), null);
    assert.equal(A.parseLine('  • Pool'), null);
    assert.equal(A.parseLine(''), null);
    assert.equal(A.parseLine(null), null);
});

// ── the happy path ───────────────────────────────────────────────────────────

test('PASS when every team takes its turn on the bye', () => {
    // Five days, five teams, one bye each — the shape a healthy run produces.
    const spec = {};
    ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06', '2026-07-07'].forEach((d, i) => {
        const sitter = TEAMS[i];
        const rest = TEAMS.filter(t => t !== sitter);
        spec[d] = [period('Game ' + (i + 1), [[rest[0], rest[1]], [rest[2], rest[3]]], [[sitter, 'Pool']])];
    });
    const L = run(spec, { byeActivity: { enabled: true, activities: ['Pool', 'Canteen'] } });

    assert.equal(L.verdict, 'PASS', 'findings: ' + JSON.stringify(L.findings));
    assert.equal(L.spread, 0);
    assert.equal(L.totalByes, 5);
    TEAMS.forEach(t => assert.equal(L.byTeam[t].byes, 1, t + ' should have exactly one bye'));
    TEAMS.forEach(t => assert.equal(L.byTeam[t].played, 4, t + ' played the other four days'));
    assert.equal(find(L, 'bye-spread').level, 'ok');
});

test('a spread of one still passes — an odd day count cannot divide evenly', () => {
    const spec = {};
    ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06', '2026-07-07', '2026-07-08'].forEach((d, i) => {
        const sitter = TEAMS[i % TEAMS.length];
        const rest = TEAMS.filter(t => t !== sitter);
        spec[d] = [period('Game ' + (i + 1), [[rest[0], rest[1]], [rest[2], rest[3]]], [[sitter, 'Pool']])];
    });
    const L = run(spec);
    assert.equal(L.spread, 1, JSON.stringify(L.byTeam));
    assert.equal(L.verdict, 'PASS');
});

// ── the failure this report exists to catch ──────────────────────────────────

test('FAIL when one team eats every bye', () => {
    const spec = {};
    ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06'].forEach((d, i) => {
        spec[d] = [period('Game ' + (i + 1), [['T1', 'T2'], ['T3', 'T4']], ['T5'])];
    });
    const L = run(spec);

    assert.equal(L.verdict, 'FAIL');
    assert.equal(L.spread, 4);
    const f = find(L, 'bye-spread');
    assert.equal(f.level, 'error');
    assert.match(f.message, /T5 sat out 4/, f.message);
    // Back-to-back byes are called out separately — the totals are not the
    // only way this shows up in real life.
    assert.ok(codes(L).includes('bye-streak'), 'consecutive-day byes should be flagged');
});

test('back-to-back byes are flagged even when the totals come out even', () => {
    // Ten days, each team sitting twice — a perfectly even 2/2/2/2/2 — but each
    // team takes both of its byes on consecutive days. The totals say fine; the
    // camp would say T1 sat out twice in a row.
    const days = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06', '2026-07-07',
                  '2026-07-08', '2026-07-09', '2026-07-10', '2026-07-13', '2026-07-14'];
    const spec = {};
    days.forEach((d, i) => {
        const sitter = TEAMS[Math.floor(i / 2)];
        const rest = TEAMS.filter(t => t !== sitter);
        spec[d] = [period('Game ' + (i + 1), [[rest[0], rest[1]], [rest[2], rest[3]]], [[sitter, 'Pool']])];
    });
    const L = run(spec);
    assert.equal(L.spread, 0, 'totals are even: ' + JSON.stringify(L.byTeam));
    assert.equal(L.verdict, 'WARN', 'findings: ' + JSON.stringify(L.findings));
    const streaks = L.findings.filter(f => f.code === 'bye-streak');
    assert.equal(streaks.length, TEAMS.length, 'every team flagged: ' + JSON.stringify(streaks));
    assert.equal(find(L, 'bye-spread').level, 'ok', 'the spread itself is still clean');
});

// ── the bye activity that rides along ────────────────────────────────────────

test('warns when a benched team always draws the same activity from a bigger pool', () => {
    const spec = {
        '2026-07-01': [period('Game 1', [['T1', 'T2'], ['T3', 'T4']], [['T5', 'Pool']])],
        '2026-07-03': [period('Game 2', [['T1', 'T3'], ['T2', 'T4']], [['T5', 'Pool']])],
    };
    const L = run(spec, { byeActivity: { enabled: true, activities: ['Pool', 'Canteen', 'Rink'] } });
    const f = find(L, 'activity-monotony');
    assert.ok(f, 'expected the monotony warning: ' + JSON.stringify(L.findings));
    assert.match(f.message, /T5 got "Pool" on all 2/, f.message);

    // Rotating through the pool is clean.
    const spec2 = {
        '2026-07-01': [period('Game 1', [['T1', 'T2'], ['T3', 'T4']], [['T5', 'Pool']])],
        '2026-07-03': [period('Game 2', [['T1', 'T3'], ['T2', 'T4']], [['T5', 'Canteen']])],
    };
    const L2 = run(spec2, { byeActivity: { enabled: true, activities: ['Pool', 'Canteen', 'Rink'] } });
    assert.ok(!codes(L2).includes('activity-monotony'), JSON.stringify(L2.findings));
    assert.deepEqual(Object.keys(L2.byTeam.T5.activities).sort(), ['Canteen', 'Pool']);
});

test('warns when Bye Activity is on but a benched team got nothing', () => {
    const spec = { '2026-07-01': [period('Game 1', [['T1', 'T2'], ['T3', 'T4']], ['T5'])] };
    const on = run(spec, { byeActivity: { enabled: true, activities: ['Pool'] } });
    assert.ok(codes(on).includes('bye-no-activity'), JSON.stringify(on.findings));

    // With the feature off, a plain bye is simply how it works — no noise.
    const off = run(spec, {});
    assert.ok(!codes(off).includes('bye-no-activity'), JSON.stringify(off.findings));
});

// ── chinuch rooms ────────────────────────────────────────────────────────────

test('FAIL when a chinuch room was over-filled in one period', () => {
    const spec = {
        '2026-07-01': [period('Game 1', [['T1', 'T2']],
            [['T5', 'Pool']], [['T3', 'Beis Medrash'], ['T4', 'Beis Medrash']])],
    };
    const L = run(spec, { chinuch: { enabled: true, roomCapacity: { 'Beis Medrash': 1 } } });
    assert.equal(L.verdict, 'FAIL');
    const f = find(L, 'room-overflow');
    assert.match(f.message, /"Beis Medrash" holds 1 but 2 teams/, f.message);
    assert.equal(L.roomIssues.length, 1);
    assert.deepEqual(L.roomIssues[0].teams, ['T3', 'T4']);

    // Same day, room raised to hold both → clean.
    const ok = run(spec, { chinuch: { enabled: true, roomCapacity: { 'Beis Medrash': 2 } } });
    assert.ok(!codes(ok).includes('room-overflow'), JSON.stringify(ok.findings));
});

test('teams in DIFFERENT periods share a room without complaint', () => {
    const spec = {
        '2026-07-01': [
            period('Game 1', [['T1', 'T2']], [['T5', 'Pool']], [['T3', 'Beis Medrash']]),
            period('Game 2', [['T1', 'T3']], [['T5', 'Canteen']], [['T4', 'Beis Medrash']]),
        ],
    };
    const L = run(spec, { chinuch: { enabled: true, roomCapacity: { 'Beis Medrash': 1 } } });
    assert.equal(L.roomIssues.length, 0, JSON.stringify(L.roomIssues));
});

test('a chinuch session is not counted as a bye', () => {
    const spec = {
        '2026-07-01': [period('Game 1', [['T1', 'T2'], ['T4', 'T5']], [], [['T3', 'Beis Medrash']])],
    };
    const L = run(spec, { chinuch: { enabled: true } }, { '2026-07-01': ['T3'] });
    assert.equal(L.byTeam.T3.chinuch, 1);
    assert.equal(L.byTeam.T3.byes, 0);
    assert.equal(L.totalByes, 0);
    assert.equal(L.verdict, 'PASS');
    assert.equal(find(L, 'no-byes').level, 'ok');
});

// ── cross-checks and plumbing ────────────────────────────────────────────────

test('flags drift between the saved schedules and the engine ledger', () => {
    const spec = { '2026-07-01': [period('Game 1', [['T1', 'T2'], ['T3', 'T4']], [['T5', 'Pool']])] };
    // History that never learned about this day at all — the grid shows a bye,
    // the fairness ledger sees nothing.
    const L = A.build({
        history: { gameLog: {}, chinuchByDate: {} },
        dailyData: dailyData(spec),
        leagues: [{ name: LG, teams: TEAMS.slice() }],
    }).leagues[0];
    const f = find(L, 'history-drift');
    assert.ok(f, JSON.stringify(L.findings));
    assert.match(f.message, /T5 \(1 on the grid, 0 in history\)/, f.message);
});

test('a game spanning two divisions counts once, not twice', () => {
    const p = period('Game 1', [['T1', 'T2'], ['T3', 'T4']], [['T5', 'Pool']]);
    const dd = { '2026-07-01': { leagueAssignments: { Juniors: { '780': p }, Seniors: { '780': p } } } };
    const L = A.build({
        history: historyFor({ '2026-07-01': [p] }),
        dailyData: dd,
        leagues: [{ name: LG, teams: TEAMS.slice() }],
    }).leagues[0];
    assert.equal(L.totalByes, 1, 'the bye is one bye, not two');
    assert.equal(L.byTeam.T1.played, 1, 'the game counts once');
    assert.equal(L.periodCount, 1);
});

test('date range filtering only audits the days asked for', () => {
    const spec = {};
    ['2026-07-01', '2026-07-02', '2026-07-03'].forEach((d, i) => {
        spec[d] = [period('Game ' + (i + 1), [['T1', 'T2'], ['T3', 'T4']], ['T5'])];
    });
    const all = run(spec);
    assert.equal(all.totalByes, 3);
    const narrowed = run(spec, null, null, { from: '2026-07-02', to: '2026-07-03' });
    assert.equal(narrowed.totalByes, 2);
    assert.deepEqual(narrowed.dates, ['2026-07-02', '2026-07-03']);
});

test('other leagues in the same saved day are ignored', () => {
    const mine = period('Game 1', [['T1', 'T2'], ['T3', 'T4']], [['T5', 'Pool']]);
    const theirs = { leagueName: 'Other League', gameLabel: 'Game 1', matchups: ['A vs B @ Court 9 (Soccer)', 'C — Bye'] };
    const dd = { '2026-07-01': { leagueAssignments: { Juniors: { '780': mine, '900': theirs } } } };
    const L = A.build({
        history: historyFor({ '2026-07-01': [mine] }),
        dailyData: dd,
        leagues: [{ name: LG, teams: TEAMS.slice() }],
    }).leagues[0];
    assert.equal(L.totalByes, 1);
    assert.ok(!L.teams.includes('C'), 'another league\'s team leaked in: ' + JSON.stringify(L.teams));
});

test('no saved data reports NO DATA instead of a false pass', () => {
    const L = A.build({ history: {}, dailyData: {}, leagues: [{ name: LG, teams: TEAMS.slice() }] }).leagues[0];
    assert.equal(L.verdict, 'NO DATA');
    assert.equal(find(L, 'no-data').level, 'info');
});

test('a team that only appears in the saved tiles is still audited', () => {
    // Renamed or removed from the roster, but it played — it must not vanish.
    const spec = { '2026-07-01': [period('Game 1', [['T1', 'T2'], ['Ghost', 'T4']], [['T5', 'Pool']])] };
    const L = A.build({
        history: historyFor(spec),
        dailyData: dailyData(spec),
        leagues: [{ name: LG, teams: ['T1', 'T2', 'T4', 'T5'] }],
    }).leagues[0];
    assert.ok(L.teams.includes('Ghost'));
    assert.equal(L.byTeam.Ghost.played, 1);
});
